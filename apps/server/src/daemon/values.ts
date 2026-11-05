import { setAgentWakePaused } from '../agent-wake-pause.js';
import { OwnedModelCredentials } from '../owned-model-credential.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { postStarterVideoPreview } from '../starter-onboarding.js';
import { sendOperatorSystemDm, readOperatorSystemDm } from '../operator-system-dm.js';
import { postRepositoryOnboarding } from '../repository-onboarding.js';
import { createAgentSubscription, listAgentSubscriptions, deleteAgentSubscription, listServiceSubscriptionEvents } from '../agent-subscriptions.js';
import { completeProviderWebhookAssignment } from '../provider-webhooks.js';
import { reportAgentSignIn } from '../agent-sign-in.js';
import { forgetSquireSignIn } from '../squire-machine.js';
import { setCornerHold } from '../corner-holds.js';
import { claimAgentCommand } from '../agent-command.js';
import { createHash, randomBytes } from 'node:crypto';
import { endComputerSession, refreshComputerSession } from '../computer-session.js';
import type { DaemonAttachment, DaemonOperationMap } from '@beeline/api-contract/daemon';
import { REPLY_EXCERPT_MAX_LENGTH } from '@beeline/api-contract/daemon';
import { GRANT_SCRIPT_MAX_BYTES, GRANT_SCRIPT_MAX_LINES, grantScriptTooLongMessage, interpreterScriptArgument, connectionInstallName, isCommandGrantScript, type AgentGrantKind, type CommandGrantRule, type CommandGrantScript } from '@beeline/api-contract/agent-grants';
import { MESSAGE_CURSOR_MS_SQL } from '../database.js';
import { type SystemPhrase } from '../system-line.js';
import { mediaIdFromUrl } from '../media-ttl.js';
import { connectApp } from '../app-connections.js';
import { deleteInstitutionalMemory, getInstitutionalContext, getInstitutionalMemoryTurnStats, reportInstitutionalMemoryUsed, saveInstitutionalMemory, searchInstitutionalMemory, updateInstitutionalMemory } from '../institutional-memory-shadow.js';
import { searchInstitutionalHistory } from '../institutional-history.js';
import { notifyFeedbackFixed } from '../feedback.js';
import { deleteSkill, loadWorkspaceSkill, saveSkill } from '../institutional-skills.js';
import { archiveWorkflow, assignWorkflowRole, handoff, getWorkflowRun, cancelWorkflowRun, saveWorkflow, startWorkflow } from '../workflow-runs.js';



export type Input<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['input'];

export type Output<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['output'];

export const id = () => randomBytes(32).toString('hex');


/**
 * A system line's subject is spoken in the Ledger's own voice, so it is the
 * PINNED registry coordinate, never the publisher's free-text title: a title
 * of `@dani` would otherwise render as a person. The leading `@` is stripped
 * so no coordinate can read as a handle either.
 */
export function registrySubject(serverName: string | null): string {
  return serverName?.replace(/^@+/, '').trim() || systemMessage("daemon-service.mcp-server");
}


export function registryMcpRouteName(serverName: string, connectorId: string): string {
  const slug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `registry-${slug || 'mcp'}-${connectorId.slice(0, 8)}`;
}


export const seconds = (date: Date) => Math.floor(date.getTime() / 1_000);


export const MAX_REPLY_STEPS = 2_000;

export const MAX_REPLY_NOTE_LENGTH = 16_000;

/** The whole stored steps payload; a note longer than one row spans several. */
export const MAX_REPLY_STEPS_BYTES = 4_000_000;

/**
 * A reply's steps (`PostRoomMessageInput.steps`) as the JSON its `activity`
 * column stores, or null when it has none. Only tool rows and notes belong
 * there; anything else is refused rather than stored.
 */
// Reserve internal notes beyond the validated helper payload for closing prose.
export function replySteps(steps: unknown, summaryNotes = 0): string | null {
  if (steps === undefined) return null;
  if (!Array.isArray(steps) || steps.length > MAX_REPLY_STEPS + summaryNotes)
    throw new Error('reply steps are invalid');
  for (const step of steps as Record<string, unknown>[]) {
    if (!step || typeof step !== 'object') throw new Error('reply steps are invalid');
    if (step.kind !== 'tool' && step.kind !== 'note') throw new Error('reply steps are invalid');
    if (typeof step.title !== 'string' || step.title.length > 240)
      throw new Error('reply steps are invalid');
    if (step.kind === 'note' &&
      (typeof step.text !== 'string' || !step.text || step.text.length > MAX_REPLY_NOTE_LENGTH))
      throw new Error('reply steps are invalid');
    if (step.continues !== undefined && (step.kind !== 'note' || step.continues !== true))
      throw new Error('reply steps are invalid');
  }
  const json = JSON.stringify(steps);
  if (Buffer.byteLength(json) > MAX_REPLY_STEPS_BYTES + summaryNotes * 100_000) throw new Error('reply steps are invalid');
  return steps.length ? json : null;
}

/** Corner reads and merge writes that also admit a current parent Room member. */
export const CORNER_REACH_OPERATIONS = new Set<string>([
  'getCornerRestoreState',
  'getPrChecksStatus',
  'getRoomAuthority',
  'getRoomConversation',
  'listCornerBriefRevisions',
  'listRoomMembers',
  'readCornerPullRequest',
  'mergeCorner',
  'approveCornerMerge',
]);

/** Closed corners still deliver stop commands and expose cleanup/history facts. */
export const CORNER_CLEANUP_OPERATIONS = new Set<string>([
  'closeCornerPullRequest',
  'getAgentCommands',
  'claimAgentCommand',
  'claimAgentTurn',
  'acknowledgeAgentCommand',
  'releaseAgentTurn',
  'getCornerCloseRequests',
  'getRoomInbox',
]);


/**
 * An expired attachment is named, not hidden: the agent is told the bytes are
 * gone so it says so, instead of reporting a download that "failed".
 */
export function markExpiredAttachments(
  attachments: readonly DaemonAttachment[],
  expired: ReadonlySet<string>,
): DaemonAttachment[] {
  if (!expired.size) return [...attachments];
  return attachments.map((attachment) => {
    const id = mediaIdFromUrl(attachment.url);
    return id && expired.has(id) ? { ...attachment, expired: true } : attachment;
  });
}


export const MEDIA_URL_PATTERN = /\/v1\/media\/([0-9a-f-]{36})$/;

export const DEFAULT_MEDIA_MAXIMUM_BYTES = 25 * 1024 * 1024;


/**
 * The caller is not a current member of the Room or corner it addressed.
 *
 * This is the one refusal `access` itself makes. A database or transport
 * failure while checking membership is a different error and must stay one:
 * translating an outage into a membership refusal hides the outage from the
 * caller and from the route's 503 default.
 */
export class AccessDeniedError extends Error {
  constructor() {
    super('daemon room access denied');
  }
}


export declare const ownedModelClaimBrand: unique symbol;

/** Process-local negotiated registration capability. Never a request argument
 * on the wire, bearer, activation snapshot or client held-state record. */
export type OwnedModelClaimCapability = Readonly<{ readonly [ownedModelClaimBrand]: true }>;

export type OwnedModelConfiguration = Readonly<{ credentials: OwnedModelCredentials; ready(): boolean }>;

export type OwnedModelNegotiation = Readonly<{ freeAgent: boolean; capability?: OwnedModelClaimCapability }>;


/**
 * The script bytes the daemon read for an interpreter command, checked against
 * the line they claim to belong to. The server never reads the operator's
 * filesystem, so this validates the daemon's reading rather than repeating it;
 * the runner re-hashes the file before every run.
 */
export function validateGrantScript(
  rule: CommandGrantRule,
  script: unknown,
): CommandGrantScript | undefined {
  const argument = interpreterScriptArgument(rule.argv);
  if (script === undefined || script === null) return undefined;
  if (!argument) throw new Error('grant script is only for an interpreter command');
  if (!isCommandGrantScript(script)) throw new Error('grant script is invalid');
  if (script.path !== argument.path) {
    throw new Error(`grant script must be the command's script argument (${argument.path})`);
  }
  // The hash is the binding, so the server re-derives it rather than trusting
  // the number it was handed: the bytes on the card and the bytes the runner
  // will check must be the same bytes.
  const bytes = Buffer.byteLength(script.contents);
  if (
    script.bytes !== bytes ||
    createHash('sha256').update(script.contents).digest('hex') !== script.sha256
  ) {
    throw new Error('grant script is invalid: its hash does not match its contents');
  }
  const lines = script.contents.split('\n').length;
  if (bytes > GRANT_SCRIPT_MAX_BYTES || lines > GRANT_SCRIPT_MAX_LINES) {
    // 'invalid' keeps this a 400 in `server.ts`'s status mapper, and the whole
    // refusal still reaches the agent as its tool error.
    throw new Error(
      `grant script is invalid: ${grantScriptTooLongMessage(script.path, bytes, lines)}`,
    );
  }
  return script;
}


/** One action line for each remaining permission ask. */
export function grantCardPhrase(
  requester: { pubkey: string; kind: 'human' | 'agent'; name: string },
  agent: { pubkey: string; name: string },
  grants: readonly { kind: AgentGrantKind; target: string; appName?: string }[],
): SystemPhrase {
  if (grants.every(grant => connectionInstallName(grant))) {
    return { subject: { kind: 'agent', id: agent.pubkey, name: agent.name },
      verb: systemMessage("daemon-service.wants-to-connect"), object: grants.map(grant => connectionInstallName(grant)).join(systemMessage("daemon-service.and")) };
  }
  return {
    subject: {
      kind: requester.kind === 'human' ? 'person' : 'agent',
      id: requester.pubkey,
      name: requester.name,
    },
    verb: systemMessage("daemon-service.wants"),
    object: grants
      .map(
        (grant) =>
          connectionInstallName(grant) ? systemMessage("daemon-service.to-connect", agent.name, connectionInstallName(grant))
            : systemMessage("daemon-service.to", agent.name, grant.kind === 'path' ? systemMessage("daemon-service.read") : grant.kind === 'repository' ? systemMessage("daemon-service.write") : grant.kind === 'shared_asset' ? systemMessage("daemon-service.isolate") : systemMessage("daemon-service.use"), grant.target),
      )
      .join(systemMessage("daemon-service.and")),
  };
}


/** The one projection an inbox or conversation row is read through. */
export const conversationColumns = `SELECT id,author_id,created_at,presentation,text,
        EXISTS(SELECT 1 FROM identities author
               WHERE author.id=messages.author_id AND author.kind='agent') agent_author,
        reply_to_message_id,
        (SELECT parent.author_id FROM messages parent WHERE parent.id=messages.reply_to_message_id) reply_to_author_id,
        (SELECT author.name FROM messages parent JOIN identities author ON author.id=parent.author_id
         WHERE parent.id=messages.reply_to_message_id) reply_to_author_name,
        (SELECT left(parent.text,${REPLY_EXCERPT_MAX_LENGTH + 1}) FROM messages parent
         WHERE parent.id=messages.reply_to_message_id) reply_to_excerpt,
        root_message_id,request_id,
        (SELECT request.author_id FROM messages request WHERE request.id=messages.request_id) request_author_id,
        agent_hop_count,attachments,system_event,
        ${MESSAGE_CURSOR_MS_SQL} cursor_ms,
        floor(extract(epoch FROM now())*1000)::bigint now_ms`;


export function laterCursor(
  candidate: string | undefined,
  previous: string | undefined,
): string | undefined {
  if (!candidate) return previous;
  if (!previous) return candidate;
  const [candidateMs, candidateId] = candidate.split(',') as [string, string];
  const [previousMs, previousId] = previous.split(',') as [string, string];
  const milliseconds = BigInt(candidateMs) - BigInt(previousMs);
  return milliseconds > 0 || (milliseconds === 0n && candidateId > previousId)
    ? candidate
    : previous;
}


/**
 * Every daemon operation the HTTP route serves, as an EXHAUSTIVE record so a
 * new operation cannot ship unroutable. `waitForCornerWake` did exactly that
 * in #912: the route answered every call 404 `unknown_daemon_operation`
 * instantly, and the corner intake loop's sleep-vs-wake race — which treated a
 * failed wake as "resolved" — became a spin against the server.
 */
export const DAEMON_OPERATION_ROUTES: Record<keyof DaemonOperationMap, true> = {
  getInstitutionalContext: true,
  saveInstitutionalMemory: true,
  updateInstitutionalMemory: true,
  deleteInstitutionalMemory: true,
  reportInstitutionalMemoryUsed: true,
  searchInstitutionalMemory: true,
  searchInstitutionalHistory: true,
  getInstitutionalMemoryTurnStats: true,
  loadWorkspaceSkill: true,
  saveSkill: true,
  deleteSkill: true,
  saveWorkflow: true,
  startWorkflow: true,
  getWorkflowRun: true,
  cancelWorkflowRun: true,
  handoff: true,
  archiveWorkflow: true,
  assignWorkflowRole: true,
  getDaemonBootstrap: true,
  getWorkspaceRoster: true,
  getOwedMentions: true,
  getRoomInbox: true,
  getRoomConversation: true,
  getRoomMessage: true,
  order: true,
  stopAgentTurn: true,
  report: true,
  read: true,
  getRoomAuthority: true,
  getPermissionAuthority: true,
  getMissionAuthority: true,
  getWorkScheduleAuthority: true,
  createAgentSchedule: true,
  setEventSubscriptions: true,
  createAgentSubscription: true,
  listServiceSubscriptionEvents: true,
  listAgentSubscriptions: true,
  deleteAgentSubscription: true,
  setAgentWakePaused: true,
  watchCorner: true,
  listEventSubscriptions: true,
  postRoomEvent: true,
  listAgentSchedules: true,
  listAgentWatches: true,
  deleteAgentSchedule: true,
  updateAgentSchedule: true,
  getAgentToolMandate: true,
  getTargetAgentAuthority: true,
  listRoomCorners: true,
  getCornerRestoreState: true,
  listCornerBriefRevisions: true,
  reviseCornerBrief: true,
  getPrChecksStatus: true,
  approveCornerMerge: true,
  mergeCorner: true,
  closeCornerPullRequest: true,
  listRooms: true,
  listReachableCorners: true,
  listRoomMembers: true,
  readCornerPullRequest: true,
  postCornerMessage: true,
  getCornerCloseRequests: true,
  listUntrackedCorners: true,
  getRoomRepositoryState: true,
  noteEmptyRoomRepository: true,
  getRoomGitHubToken: true,
  dispatchRoomWorkflow: true,
  getRoomTargetBranch: true,
  getIdentitySuccession: true,
  getAgentConfiguration: true,
  getAgentPresence: true,
  getRequestCompletion: true,
  getAgentCommands: true,
  claimAgentCommand: true,
  claimAgentTurn: true,
  acknowledgeAgentCommand: true,
  releaseAgentTurn: true,
  postRoomMessage: true,
  reactToRoomMessage: true,
  postAgentAttachment: true,
  postAgentDraft: true,
  postAgentThought: true,
  retractAgentLiveOutput: true,
  postAgentTurnReceipt: true,
  markAgentTurnSilent: true,
  postAgentActivity: true,
  postBackgroundToolCompletion: true,
  postSquireApproval: true,
  postComputerSession: true,
  endComputerSession: true,
  refreshComputerSession: true,
  postSquireLoginWall: true,
  postSquireApprovalDecision: true,
  postPermissionRequest: true,
  postPermissionExecution: true,
  postAgentToolMandate: true,
  getAgentAvatar: true,
  postAgentAvatar: true,
  postAgentUsage: true,
  publishAgentUsageAccount:true,
  readCommandActivation:true,
  attachAgentUsageAccount:true,
  getAgentUsage: true,
  answerUsageRefresh: true,
  postAgentCommands: true,
  postAgentModelCatalog: true,
  postAgentMachineReport: true,
  getConnectorAssignments: true,
  completeProviderWebhookAssignment: true,
  reportAgentSignIn: true,
  getGoogleOAuthGrant: true,
  createLinkSpendRequest: true,
  retrieveLinkSpendRequest: true,
  getRoomGoogleGrant: true,
  beginRegistryMcpOAuth: true,
  claimRegistryMcpOAuthCode: true,
  installConnector: true,
  postConnectorStatus: true,
  postConnectorVault: true,
  forgetSquireSignIn: true,
  getConnectorStatus: true,
  getConnectorVaultList: true,
  getConnectionDetail: true,
  revokeConnectionGrants: true,
  postConnectionUsage: true,
  postCornerRemoteState: true,
  postCornerPlan: true,
  renameCorner: true,
  postTargetBranchProposal: true,
  requestAgentGrant: true,
  postRepositoryOnboarding: true,
  postRoomInvite: true,
  postStarterWelcome: true,
  postStarterVideoPreview: true,
  askRoomChoice: true,
  openRoomPoll: true,
  listAgentGrants: true,
  listAgentGrantRequests: true,
  consumeAgentGrant: true,
  authorizeSquireCall: true,
  authorizeResourceCall: true,
  authorizeRepositoryCall: true,
  authorizeHostCall: true,
  listTurnAgentGrants: true,
  readAgentWorkbench: true,
  searchMcpRegistry: true,
  connectMcpServer: true,
  connectApp: true,
  connect: true,
  findConnectors: true,
  listAppTools: true,
  executeAppTool: true,
  offerConnector: true,
  postVaultSaveCard: true,
  createCorner: true,
  setCornerHold: true,
  orderCornerMerge: true,
  archiveCorner: true,
  ensureAgentMembership: true,
  getWalletToolState: true,
  getWalletToolBalance: true,
  getWalletToolChains: true,
  getWalletToolHistory: true,
  getWalletToolQuote: true,
  walletPay: true,
  walletSwap: true,
  walletContractCall: true,
  walletSignTypedData: true,
  reportFeedback: true,
  notifyFeedbackFixed: true,
  sendOperatorSystemDm: true,
  readOperatorSystemDm: true,
};
