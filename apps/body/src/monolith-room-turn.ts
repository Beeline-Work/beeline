import { TurnUsageAccumulator } from './turn-usage.js';
import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';
import type { InterruptedTurn } from './force-update-journal.js';
import { SquireTaskRelay } from './squire-task-relay.js';
import { resourceCallFacts } from './resource-mcp-facade.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { parseGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import {
  SCHEDULE_RAN_VERB,
  SCHEDULE_SCHEDULER_NAME,
} from '@beeline/api-contract/scheduled-prompts';
import { type SystemEvent } from '@beeline/api-contract/daemon';
import {
  AcpClient,
  AcpTurnBackstopError,
  TURN_BACKSTOP_MS,
  isPureRetryNarration,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type McpServerWire,
  type PromptResult,
  type ToolCallEntry,
} from './acp.js';
import {
  expectedMountedImportedMcpServerNames,
  grantedSquireHostBindPaths,
  harnessStateDirsFromEnv,
  hostImportedMcpDeclarations,
  hostImportedMcpServerNames,
  freshHarnessLoginLine,
  isExpiredHarnessLoginError,
  mountedImportedMcpServerNames,
  prepareRoomAgentHome,
  repairRoomAgentCredentialLinks,
  writeBackRoomClaudeLogin,
} from './agent-home.js';
import {
  claimGrantedHostRoutes,
  grantedHostRouteWires,
  grantedSquireHostRoute,
  ungatedHostServers,
} from './host-mcp-route.js';
import { openRouterRoutingInput } from './openrouter-routing.js';
import { agentCommandCatalogPublisher } from './agent-command-catalog.js';
import {
  attachmentImageBlocks,
  attachmentMarkerLines,
  attachmentPromptLines,
  deliverAttachments,
  promptWithImages,
  withoutImageData,
  type DeliveredAttachment,
} from './attachment-delivery.js';
import { installPiMcpBridge } from './pi-mcp-bridge.js';
import {
  beelineAgentMcpServer,
  readOnlyMcpServer,
} from './room-session.js';
import { awaitInstitutionalContext, startInstitutionalContextFetch } from './institutional-context.js';
import { modelContextWindowTokens } from './model-context-window.js';
import {
  codegraphFingerprintServers,
  codegraphIndexDirectory,
  codegraphMcpServer,
  prepareCodegraphIndex,
} from './codegraph.js';
import { sessionConfigFingerprint } from './session-config-fingerprint.js';
import { registryMcpHostBindPaths, registryMcpHostDeclarations } from './registry-mcp.js';
import { CODE_OWNED_HOST_MCP_NAMES } from './mcp-route-class.js';
import {
  isHostMcpPermissionRequest,
  isMcpShapedPermissionRequest,
  isMountedMcpToolPermissionRequest,
  ROOM_MOUNTED_MCP_SERVERS,
} from './read-only-policy.js';
import {
  credentialMaskPaths,
  grantedSandboxDevices,
  harnessHomeStateDirs,
  siblingAgentMaskPaths,
  wrapAgentCommand,
} from './bwrap-sandbox.js';
import { harnessIdentityLabel } from './cursor-acp-bridge.js';
import type { BodyConfig } from './config.js';
import { type DaemonApiClient } from './daemon-api-client.js';
import {
  explainEmptyAgentTurn,
  isContextOverflowTurn,
  nextPinnedProvider,
  shouldFailOverProviderError,
  shouldRetryEmptyTurn,
  turnFailureReasonWithProvider,
  type EmptyTurnExplanation,
} from './empty-turn.js';
import type { GrantCommandRunner, GrantRunnerEndpoint, GrantWritePolicy } from './grant-runner.js';
import { roomShellCapability } from './harness-capabilities.js';
import {
  agentArgsWithModelSelection,
  applyAgentModelSelection,
  filterAllowedModelConfigOptions,
  parseAdvertisedConfigOptions,
} from './model-config.js';
import type { AgentModelConfigOption } from './model-types.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeDirectory, runtimeIdentity } from './runtime.js';
import {
  assembleSessionPrompt,
  assembleTurnPrompt,
  roomMentionDirectory,
  type PromptSurface,
} from './prompt-assembly.js';
import { TurnStoppedError } from './turn-stop.js';
import { AgentTurnStream, durableReplyText } from './turn-stream.js';
import { TurnTrace, TurnTraceFile, type TurnTraceSink } from './turn-trace.js';
import { isCompletedToolCall, toolCallFailureLine } from './tool-call-failure.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import { withTurnReceiptHeartbeat } from './turn-receipt-heartbeat.js';
import { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';
import { WarmTranscript } from './warm-transcript.js';
import type { RoomSupervisor } from './room-supervisor.js';

export const ROOM_PROMPT_BACKSTOP_MS = TURN_BACKSTOP_MS;

type WorkspaceRoster = DaemonOperationMap['getWorkspaceRoster']['output'];
type RoomRepositoryState = DaemonOperationMap['getRoomRepositoryState']['output'];
type RoomMessage = DaemonOperationMap['getRoomInbox']['output']['items'][number];
type HumanMessage = Pick<
  RoomMessage,
  | 'id'
  | 'authorId'
  | 'body'
  | 'createdAt'
  | 'attachments'
  | 'type'
  | 'replyToMessageId'
  | 'replyToAuthorId'
  | 'requestAuthorId'
  | 'agentHopCount'
  | 'cornerAskId'
>;

/**
 * Rooms and corners share one rule for MCP: every tool call from a server the
 * host mounted into the session is approved. A host-classified server is kept
 * out of the isolated harness home until an owner grant rewrites the route in;
 * a call that reaches an ungated host identity stays refused here. Granted
 * names drop out of that host list so every capability on that server crosses.
 */
export function isRoomMcpPermissionRequest(
  request: AcpPermissionRequest,
  mountedServers: readonly string[] = ROOM_MOUNTED_MCP_SERVERS,
  hostServers: readonly string[] = CODE_OWNED_HOST_MCP_NAMES,
): boolean {
  if (isHostMcpPermissionRequest(request, hostServers)) return false;
  return isMountedMcpToolPermissionRequest(request, mountedServers);
}

/**
 * A shell command, read from the only thing that identifies one: the `execute`
 * kind the harness itself declares. claude-agent-acp marks its native `Bash`
 * that way, which is the whole of what a Room shell needs; a title or a command
 * line that happens to contain the word `bash` is prose, not an identity, and
 * classifying on it moved the boundary with the user's wording. An MCP-shaped
 * request is never re-read as a shell: it was already decided above, so a
 * command line wearing an inspection tool's title stays refused instead of
 * crossing as the shell it also is.
 */
function isRoomShellPermissionRequest(
  request: AcpPermissionRequest,
  hostServers: readonly string[],
): boolean {
  if (request.toolCall?.kind !== 'execute') return false;
  return !isMcpShapedPermissionRequest(request, hostServers);
}

/**
 * The Room ACP client applies this host-owned decision fail-closed: a mounted
 * MCP tool call is approved, a shell command is approved while the OS sandbox
 * wraps this session, and nothing else crosses (native reads/writes,
 * unstructured requests).
 *
 * Shell is conditioned on the sandbox because the sandbox IS the Room's
 * read-only filesystem: unwrapped, `wrapAgentCommand` spawns the harness bare
 * and masks no credential path, so an approved command would write anywhere the
 * daemon account can. Codex keeps its own offline read-only mode in exactly
 * that case (`harness-capabilities.ts`), so requiring the wrap is what parity
 * means. `ensureBwrapSandbox` installs bubblewrap at daemon start so this is a
 * capability the host gains rather than a refusal it lives with, and the
 * session primer states the outcome either way.
 */
export function roomPermissionDecision(
  request: AcpPermissionRequest,
  options: {
    mountedServers?: readonly string[];
    hostServers?: readonly string[];
    /** `config.bwrapPath`, set only when the sandbox self-test passed. */
    shellSandboxed?: boolean;
  } = {},
): AcpPermissionDecision {
  const hostServers = options.hostServers ?? CODE_OWNED_HOST_MCP_NAMES;
  const mountedServers = options.mountedServers ?? ROOM_MOUNTED_MCP_SERVERS;
  if (isRoomMcpPermissionRequest(request, mountedServers, hostServers)) return 'allow';
  if (!options.shellSandboxed) return 'reject';
  return isRoomShellPermissionRequest(request, hostServers) ? 'allow' : 'reject';
}

/**
 * Whether this principal may start a turn. Agents are server-validated Room members
 * and are never gated; a human answers to the agent's access policy.
 *
 * The policy lives on the SERVER (`agent-access.ts`) and its verdict rides on the
 * authority round trip the intake loop already makes per candidate message — so an
 * owner's change in the members page takes effect on a helper that is already
 * running, on its next poll. `humanPermitted` is the runtime record's own reading,
 * used only against a server too old to answer.
 */
/** Server-authored scheduled prompts arrive as system lines (`@scheduler ran a
 *  schedule for <agent> · <message>`) carrying the structured event; the
 *  scheduler is not a Room principal, so its lines skip the per-author
 *  authority check (schedule creation was already authority-gated). Recognised by
 *  the event's verb, never by the text.
 *
 *  Nothing here re-checks that the line is addressed to this agent. An inbox
 *  item exists BECAUSE the server routed it to this agent, so the item IS the
 *  address; asking the line to name the reader again only invites the two to
 *  disagree. */
export function isScheduledPrompt(item: {
  type: string;
  body: string;
  systemEvent?: SystemEvent;
}): boolean {
  if (item.type !== 'system') return false;
  if (item.systemEvent?.kind) return item.systemEvent.kind === 'schedule-ran';
  // One release of fallback: a line written before the server stamped kinds
  // carries the verb and nothing else. Remove after the next release; the
  // verb is display text and must not be a permanent contract.
  return item.systemEvent?.verb === SCHEDULE_RAN_VERB;
}

/**
 * Who the harness is told an inbox item is from.
 *
 * An event line's subject is the person or agent the fact is ABOUT, and the
 * server put their display name on the structured event. A newcomer's join is
 * the case that needs it: the roster this turn was built from was read before
 * they arrived, so a lookup by author id finds nothing and the greeting comes
 * out addressed to a truncated public key instead of a name.
 */
export function inboxItemAuthorName(
  item: {
    type: string;
    authorId: string;
    body: string;
    systemEvent?: SystemEvent;
  },
  names: ReadonlyMap<string, string>,
): string {
  if (isScheduledPrompt(item)) return SCHEDULE_SCHEDULER_NAME;
  const subject = item.systemEvent?.subject;
  if (item.type === 'system' && subject?.name) return subject.name;
  return names.get(item.authorId) ?? item.authorId.slice(0, 12);
}

/** What the harness is shown for an inbox item: a scheduled prompt's message
 *  itself (the event's consequence), otherwise the row's text. An event line's
 *  own sentence already carries the fact — `Ada joined Beeline Welcome` names
 *  the newcomer — so it is shown as written rather than restated. */
export function inboxItemPromptBody(item: {
  type: string;
  body: string;
  systemEvent?: SystemEvent;
}): string {
  return isScheduledPrompt(item) ? (item.systemEvent?.consequence ?? item.body) : item.body;
}

/**
 * A `request_grant` or `offer_connector` call whose reply says the card is
 * posted pauses the turn: the person's answer on that card resumes it (a
 * `grant-decided` or `connector-offer-decided` RESUME kind).
 */
type PendingCardKind = 'grant' | 'connector';
function pendingCardKind(call: { title?: string; content?: unknown }): PendingCardKind | undefined {
  const kind = /(?:^|[._:/-])(request_grant|offer_connector)$/i.exec(call.title ?? '')?.[1];
  if (!kind || !/(?:pending|already offered), card (?:posted|still open)/i.test(
    typeof call.content === 'string' ? call.content : JSON.stringify(call.content ?? ''),
  )) return undefined;
  return kind.toLowerCase() === 'request_grant' ? 'grant' : 'connector';
}

export function pendingGrantToolCall(call: { title?: string; content?: unknown }): boolean {
  return pendingCardKind(call) !== undefined;
}

/**
 * The device an instantly approved `request_grant` added this turn, if any.
 * bwrap fixes `/dev` when a session starts, so the turn loop runs the same turn
 * again in a fresh session that has it (`deviceGrantResumePrompt`).
 */
export function approvedDeviceGrant(
  calls: readonly { title?: string; content?: unknown }[],
): string | undefined {
  for (const call of calls) {
    if (!/(?:^|[._:/-])request_grant$/i.test(call.title ?? '')) continue;
    const text = typeof call.content === 'string' ? call.content : JSON.stringify(call.content ?? '');
    const device = /approved: use (\/dev\/\S+) \[grant [^\]]*\]\. A running session cannot add a device/.exec(text)?.[1];
    if (device) return device;
  }
  return undefined;
}

/** The prompt that continues a turn after an instantly approved device grant. */
export function deviceGrantResumePrompt(device: string, earlierReply: string): string {
  const earlier = earlierReply.trim();
  return [
    `Your device grant for ${device} was approved and ${device} is in this session now; this is the same turn continuing.`,
    ...(earlier ? [`Your reply just before this was: ${earlier}`] : []),
    'Continue the work that needed the device. Do not request it again or ask anyone to restart.',
  ].join(' ');
}

/**
 * The resume prompt for the answer that woke a paused turn. A grant answer and
 * a connector-offer answer resume the same way (`RESUME_KINDS`), but the model
 * must be told which question was answered — the connector one arrives as
 * `<person> added <tool>`, and its right response is to acknowledge and carry
 * on with the work that needed the tool, not to look for a grant verdict.
 */
export function resumePrompt(item: { body: string; systemEvent?: SystemEvent }): string {
  if (item.systemEvent?.kind === 'squire-approval-decided') {
    return [
      `This is Trusty Squire's answer to the approval you were waiting on: ${item.body}.`,
      'Your paused work resumes now.',
      'If it was approved, continue exactly where you left off with Trusty Squire; do not ask the person to approve again, and do not restart the task.',
      'If it was denied, stop that Trusty Squire action and say plainly what you cannot do.',
    ].join(' ');
  }
  if (item.systemEvent?.kind === 'connector-offer-decided') {
    return [
      `This is the answer to your connector offer: ${item.body}.`,
      'Your paused work resumes now. The tool is being installed on your machine; its sign-in and status reach the person through the tool’s own status message, not through you.',
      'Acknowledge in one short line (for example "Adding Trusty Squire now.") and continue the work that needed it, or say plainly what still has to happen before you can.',
    ].join(' ');
  }
  const grant = parseGrantDecisionLine(item.body);
  if (grant?.kind === 'device' && grant.decision !== 'deny') {
    return [
      'This is the answer to your grant request; your paused work resumes now.',
      `The approved device ${grant.target} is in this session.`,
      'Continue the paused work with it now; do not restart, schedule another turn, or request the device again.',
    ].join(' ');
  }
  if (grant?.kind === 'mcp' && grant.decision !== 'deny') {
    return [
      'This is the answer to your grant request; your paused work resumes now.',
      `The approved ${grant.target} route is mounted in this session.`,
      'Continue the paused work with that tool now; do not restart, schedule another turn, or request the route again.',
    ].join(' ');
  }
  return [
    'This is the answer to your grant request; your paused work resumes now.',
    'If it was approved and it is a command grant, run it with run_granted_command and the exact argv.',
    'If it was declined, try another way or say plainly what you cannot do.',
  ].join(' ');
}

/**
 * The Room's members and the one @spelling that reaches each of them.
 *
 * Everywhere else the prompt names people by DISPLAY name — the transcript's
 * bylines, `Current task selected by the server from <name>` — and nothing in it ever carried a
 * handle. So a model with something to say to someone had no authoritative
 * spelling to write and had to guess one, or copy one out of the conversation,
 * where a handle retired releases ago still sits in its own old messages. A
 * guessed tag resolves to nobody, and nobody is told it was written.
 *
 * Built from the roster this turn was fetched with, so a newcomer is taggable
 * on the turn they arrive. The server resolves tags in the final reply against
 * current Room membership when it stores the message.
 */
interface ActiveTurn {
  item: HumanMessage;
  steers: HumanMessage[];
  steerTail: Promise<void>;
  resumeRequested: boolean;
  /** The requester stopped this turn: publish nothing, settle nothing. */
  cancelled: boolean;
  phase: 'prompting' | 'finishing';
  promise: Promise<void>;
}

export interface MonolithRoomTurnHealth {
  poll(): void;
}

export interface MonolithRoomTurnOptions {
  roomId: string;
  workspaceId: string;
  cwd: string;
  /** Refresh the server-bound checkout before each admitted Room turn. */
  refreshCheckout?: () => Promise<{ cwd: string; branch?: string; commit?: string }>;
  runtime: AgentRuntimeRecord;
  config: BodyConfig;
  api: DaemonApiClient;
  scheduler: SessionScheduler;
  health: MonolithRoomTurnHealth;
  onSubscriptionState?: (connected: boolean) => void;
  onIntakeError?: (error: unknown) => void;
  signal?: AbortSignal;
  pollMs?: number;
  createAcpClient?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
  onCornerOpened?: () => void;
  onRestartRequested?: () => void;
  canStartTurn?: () => boolean;
  /** Keeps this Room's intake alive across failed reads. */
  supervisor?: RoomSupervisor;
  /** Attachment downloads (test seam). */
  fetchImpl?: typeof fetch;
  /** The daemon's command-grant runner; this Room registers its checkout and current turn. */
  grantRunner?: GrantCommandRunner;
  grantRunnerEndpoint?: GrantRunnerEndpoint;
}

/**
 * Monolith-only Room turn leaf.
 *
 * This module deliberately has no relay client, relay URL, Nostr event, or
 * BuzzClient dependency. The transport cutover is therefore structural: a
 * monolith Room cannot accidentally fall through to a retired relay call.
 */
export class MonolithRoomTurnLoop {
  private readonly commandContext: CommandExecutionContext;
  private readonly squireRelay: SquireTaskRelay;
  private readonly agent: ReturnType<typeof runtimeIdentity>;
  private wakeIntake?: () => void;

  /** Called by the daemon's one slow workspace reconciliation sweep. */
  requestReconciliation(): void {
    this.wakeIntake?.();
    this.wakeIntake = undefined;
  }
  private client?: AcpClient;
  private sessionId?: string;
  private sessionCwd?: string;
  private sessionCommit?: string;
  private turnCheckout?: { branch?: string; commit?: string };
  /** The configuration the live session baked in; a change invalidates it. */
  private sessionFingerprint?: string;
  /** Whether CodeGraph preparation succeeded for the live session. */
  private sessionCodegraphReady = false;
  /** The live session's environment, read back for pi's own turn record. */
  private agentEnv: Record<string, string> = {};
  /**
   * The real size of the last settled prompt, captured while the session that
   * sent it is still alive — `discardSession` clears both the client and the id,
   * and the terminal receipt is posted on a path that may run after it.
   */
  private turnMetrics: {
    inputTokens?: number;
    promptBytes?: number;
    totalInputTokens?: number;
    modelCalls?: number;
    modelCallsWithoutUsage?: number;
  } = {};
  private turnUsage = new TurnUsageAccumulator();
  /** OpenRouter providers this activation pinned, in order (C92). */
  private pinnedProviders: string[] = [];
  /** The one provider re-pinned after an empty completion, until the session ends. */
  private pinnedProviderOverride?: string;
  private busy = false;
  private turnInstructionPrefix = '';
  /** The session prompt's section ids, for `report_feedback` (with each turn's). */
  private sessionPromptSectionIds: readonly string[] = [];
  private sessionSurface: PromptSurface = 'room';
  private activeTurn?: ActiveTurn;
  private readonly queuedTurns: HumanMessage[] = [];
  /** Session scratch directory attachments are downloaded into (`TMPDIR/beeline-attachments`). */
  private attachmentDir?: string;
  private modelContextTokens?: number;
  /** Whether the pinned model takes images; `undefined` when the pin did not say. */
  private modelTakesImages?: boolean;
  /** The session's TMPDIR: writable to a granted command in a Room, as it is to the harness (C94). */
  private sessionScratchDir?: string;
  /** The `agent-home.ts` overlay this session writes into; a Room grant keeps it. */
  private sessionStateDirs: string[] = [];
  /** What this exact ACP session has already been prompted with (`warm-transcript.ts`). */
  private readonly warmTranscript = new WarmTranscript();
  /** Local copies already delivered this session, by message id, so transcript renders reuse them. */
  private readonly deliveredAttachments = new Map<string, DeliveredAttachment[]>();
  /** Names from the latest roster read, for ledger bylines the runner writes. */
  private memberNames = new Map<string, string>();
  /** The request id of the turn that paused on a grant card, until its decision arrives. */
  private pausedOnGrantRequestId?: string;
  private pausedOnGrantKind?: PendingCardKind;
  /** Operator-local turn traces; built once when the daemon configured a directory. */
  private turnTraceSink?: TurnTraceSink;

  constructor(private readonly options: MonolithRoomTurnOptions) {
    this.agent = runtimeIdentity(options.runtime.agent);
    this.commandContext = new CommandExecutionContext(options.config.agentHomeRoot);
    this.squireRelay = new SquireTaskRelay(
      this.agent.publicKey,
      options.roomId,
      this.commandContext.path,
      async (call) =>
        (
          await options.api.execute('authorizeResourceCall', {
            roomId: call.roomId,
            requestId: call.requestId,
            generationId: call.generationId,
            target: 'squire',
            ...resourceCallFacts(
              { method: 'tools/call', params: { name: call.tool, arguments: call.args } },
              'squire',
            ),
          })
        ).allowed,
      options.config.operatorHome ?? homedir(),
      undefined,
      (decision) => {
        options.api
          .execute('postSquireApprovalDecision', { roomId: options.roomId, ...decision })
          .catch(() => {});
      },
    );
    this.options = { ...options, api: this.commandContext.bind(options.api) };
    options.grantRunner?.register(options.roomId, {
      workspaceId: options.workspaceId,
      cwd: options.cwd,
      // A top-level Room keeps its read-only promise for grants too: the runner
      // wraps the command in this Room's own mount table (C94).
      writePolicy: () => this.grantWritePolicy(),
      turn: () => {
        const turn = this.currentTurnForRunner();
        return turn ? { ...turn, generationId: this.commandContext.generationId } : undefined;
      },
    });
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** The turn a `request_grant` paused, if any (cleared when its decision resumes it). */
  pausedGrantRequestId(): string | undefined {
    return this.pausedOnGrantRequestId;
  }

  /**
   * What the grant runner may write here: the session's own scratch and home
   * overlay and nothing else, enforced by the same read-only mount table the
   * harness runs under. With no usable bwrap there is no way to keep that
   * promise, so the policy carries no path and the runner refuses the run
   * rather than widening the boundary.
   */
  private grantWritePolicy(): GrantWritePolicy {
    return {
      surface: 'room',
      ...(this.options.config.bwrapPath ? { bwrapPath: this.options.config.bwrapPath } : {}),
      ...(this.sessionScratchDir ? { scratch: this.sessionScratchDir } : {}),
      ...(this.sessionStateDirs.length ? { harnessStateDirs: this.sessionStateDirs } : {}),
      maskPaths: [
        ...credentialMaskPaths(
          this.options.config.sandboxMaskPaths,
          this.options.config.operatorHome ?? homedir(),
        ),
        ...siblingAgentMaskPaths(
          runtimeDirectory(this.options.runtime.supervisorRoot, this.options.runtime.agent.publicKey),
        ),
      ],
    };
  }

  /**
   * One turn's stopwatch. It is created for every turn — measuring is cheap —
   * and only WRITES when the daemon configured a runtime directory to write
   * into, so a standalone or test Body stays silent.
   */
  private beginTurnTrace(requestId: string): TurnTrace {
    const directory = this.options.config.turnTraceDir;
    if (directory) this.turnTraceSink ??= new TurnTraceFile(directory);
    return new TurnTrace({
      surface: 'room',
      agentId: this.agent.publicKey,
      roomId: this.options.roomId,
      requestId,
      ...(this.turnTraceSink ? { sink: this.turnTraceSink } : {}),
    });
  }

  private currentTurnForRunner():
    { requestId: string; requester?: { pubkey: string; name?: string } } | undefined {
    const active = this.activeTurn;
    if (!active) return undefined;
    return { requestId: active.item.id, requester: this.requesterOf(active.item.authorId) };
  }

  private requesterOf(authorId: string): { pubkey: string; name?: string } {
    const name = this.memberNames.get(authorId);
    return { pubkey: authorId, ...(name ? { name } : {}) };
  }

  async refreshPersonaForSoulUpdate(): Promise<void> {
    await this.options.scheduler.suspend(this.options.roomId);
  }

  async prepareForForcedUpdateRestart(): Promise<void> {
    // Ordinary managed updates keep their existing idle/drain behavior.
  }

  interruptForServerMinimum(): InterruptedTurn | undefined {
    const active = this.activeTurn;
    if (!active || active.cancelled) return undefined;
    active.cancelled = true;
    if (this.client && this.sessionId) this.client.sessionCancel(this.sessionId);
    return {
      roomId: this.options.roomId,
      requestId: active.item.id,
      generationId: this.commandContext.generationId,
    };
  }

  async forceRecoverRoom(): Promise<void> {
    if (this.client && this.sessionId) this.client.sessionCancel(this.sessionId);
    await this.options.scheduler.forceSuspend(this.options.roomId);
  }

  private async roster(): Promise<WorkspaceRoster> {
    const roster = await this.options.api.execute('getWorkspaceRoster', {
      agentId: this.agent.publicKey,
      workspaceId: this.options.workspaceId,
    });
    this.memberNames = new Map(roster.members.map((member) => [member.identityId, member.name]));
    return roster;
  }

  /**
   * Whether a picture actually reaches the model this session. Both halves
   * have to hold (C87): the harness must advertise `promptCapabilities.image`,
   * AND — when the pin knows the model's modalities — the model must take
   * images. `undefined` modalities mean the question was never settled, and
   * the harness answer stands alone as before.
   */
  private acceptsImages(): boolean {
    if (!(this.client?.canPromptWithImages() ?? false)) return false;
    return this.modelTakesImages ?? true;
  }

  /** Reuse successful local copies; a later delivery retries failed files. */
  private async deliver(item: HumanMessage): Promise<DeliveredAttachment[]> {
    if (!item.attachments.length || !this.attachmentDir) return [];
    const cached = this.deliveredAttachments.get(item.id);
    if (cached?.length === item.attachments.length) return cached;
    const delivered = await deliverAttachments(
      item.attachments,
      join(this.attachmentDir, item.id.replace(/[^\w-]/g, '_')),
      this.options.fetchImpl,
      cached,
    );
    this.deliveredAttachments.set(item.id, withoutImageData(delivered.filter((entry) => entry.path)));
    return delivered;
  }

  private repositoryState(): Promise<RoomRepositoryState> {
    return this.options.api.execute('getRoomRepositoryState', { roomId: this.options.roomId });
  }

  /**
   * Drop this Room's live harness process. The next activation starts cold.
   * A rotation is a fact about one live session, so the pin goes with it.
   */
  /**
   * Claude Code may have refreshed its login during the prompt, detaching
   * this Room's credential link. Share the rotated login now so other Rooms
   * do not spend the old refresh token before this Room's next activation.
   */
  private async writeBackClaudeLogin(): Promise<void> {
    if (this.options.config.agentKind !== 'claude' || !this.options.config.agentHomeRoot) return;
    await writeBackRoomClaudeLogin({
      root: this.options.config.agentHomeRoot,
      operatorHome: this.options.config.operatorHome,
    }).catch((error: unknown) => {
      console.error(`[thin-core] monolith Room ${this.options.roomId} could not write back a refreshed Claude login:`, error);
    });
  }

  /**
   * What this turn really cost and did, read at the moment its prompt settled.
   *
   * The token count is the harness's own (pi records it; every other harness
   * leaves it unknown) and the byte count is the prompt this process handed over
   * — together they are the only way the rollout budget gate can measure the
   * institutional block's share of a real prompt instead of a byte estimate.
   * Missing numbers are omitted rather than zeroed.
   */
  private async captureTurnMetrics() {
    const { model: _model, ...usage } = this.turnUsage.usage ?? {};
    const promptBytes = this.client?.lastPromptBytes;
    return {
      ...usage,
      ...(promptBytes ? { promptBytes } : {}),
    };
  }

  private async discardSession(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.sessionId = undefined;
    this.sessionCwd = undefined;
    this.sessionCommit = undefined;
    this.sessionFingerprint = undefined;
    this.sessionCodegraphReady = false;
    this.pinnedProviderOverride = undefined;
    if (client?.isAlive) await client.stop();
  }

  /**
   * Whether the retained session still matches the agent's server-side
   * configuration. Retention (C104) is a saving only while what it keeps is
   * still current, and a session's persona, model pin, and mounted MCP set are
   * fixed when it opens: they cannot be corrected in place, so a changed one
   * has to cost a respawn. The check is one round trip — the roster half of
   * which the turn was going to fetch anyway — against a cold spawn measured
   * in seconds.
   */
  private async sessionIsCurrent(): Promise<boolean> {
    await this.refreshTurnCheckout();
    return (
      this.sessionCwd === this.options.cwd &&
      this.sessionCommit === this.turnCheckout?.commit &&
      (await this.currentSessionFingerprint()) === this.sessionFingerprint
    );
  }

  private async refreshTurnCheckout(): Promise<void> {
    const checkout = await this.options.refreshCheckout?.();
    if (!checkout) return;
    this.turnCheckout = checkout;
    if (checkout.cwd === this.options.cwd) return;
    this.options.cwd = checkout.cwd;
    this.options.grantRunner?.register(this.options.roomId, {
      workspaceId: this.options.workspaceId,
      cwd: checkout.cwd,
      writePolicy: () => this.grantWritePolicy(),
      turn: () => {
        const turn = this.currentTurnForRunner();
        return turn ? { ...turn, generationId: this.commandContext.generationId } : undefined;
      },
    });
  }

  private async currentSessionFingerprint(): Promise<string> {
    const [configuration, roster, grants] = await Promise.all([
      this.options.api.execute('getAgentConfiguration', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
      }),
      this.roster(),
      this.grantedResources(),
    ]);
    const { hostRoutes: grantedHostRoutes, devices: grantedDevices } = grants;
    const self = roster.members.find((member) => member.identityId === this.agent.publicKey);
    const registryRoutes = configuration.registryMcpRoutes ?? [];
    return sessionConfigFingerprint({
      devices: grantedDevices,
      model: configuration.model ?? this.options.config.modelSelection?.model,
      effort: configuration.effort ?? this.options.config.modelSelection?.effort,
      fastMode: configuration.fastMode,
      soul: configuration.soul ?? self?.soul,
      agentName: self?.name ?? this.agent.name,
      mcpServers: codegraphFingerprintServers(
        this.options.config,
        [
          ...expectedMountedImportedMcpServerNames({
            operatorHome: this.options.config.operatorHome,
            agentKind: this.options.config.agentKind,
            grantedHostRoutes: [
              ...grantedHostRoutes,
              ...registryRoutes.map((route) => route.routeName),
            ],
          }),
          ...registryRoutes.map((route) => route.routeName),
        ],
        this.sessionCodegraphReady,
      ),
    });
  }

  private async grantedResources(): Promise<{ hostRoutes: string[]; devices: string[] }> {
    try {
      const grants = await this.options.api.execute('listAgentGrants', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
      });
      const approved = await claimGrantedHostRoutes(grants);
      // Discovery is safe to mount; the transport gate authorizes every use.
      // This also lets an owner use a yolo resource without an activation prompt.
      return {
        hostRoutes: [
          ...new Set([
            ...approved,
            ...Object.keys(
              hostImportedMcpDeclarations({
                operatorHome: this.options.config.operatorHome,
                agentKind: this.options.config.agentKind,
              }),
            ),
          ]),
        ],
        devices: grantedSandboxDevices(grants),
      };
    } catch {
      return { hostRoutes: [], devices: [] };
    }
  }

  private mountedMcpServers(preparedEnv?: Record<string, string>): string[] {
    return mountedImportedMcpServerNames({
      operatorHome: this.options.config.operatorHome,
      agentKind: this.options.config.agentKind,
      preparedEnv,
    });
  }

  private async activate(trace?: TurnTrace): Promise<string> {
    await this.refreshTurnCheckout();
    if (this.client?.isAlive && this.sessionId) {
      if (this.options.config.agentHomeRoot) {
        await repairRoomAgentCredentialLinks({
          root: this.options.config.agentHomeRoot,
          operatorHome: this.options.config.operatorHome,
          writeBackNewerClaudeLogin: this.options.config.agentKind === 'claude',
        });
      }
      return this.sessionId;
    }
    trace?.noteActivation('cold');
    const [configuration, roster, repositoryState, grants] =
      await Promise.all([
        this.options.api.execute('getAgentConfiguration', {
          agentId: this.agent.publicKey,
          roomId: this.options.roomId,
        }),
        this.roster(),
        this.repositoryState(),
        this.grantedResources(),
        ]);
    const { hostRoutes: grantedHostRoutes, devices: grantedDevices } = grants;
    const self = roster.members.find((member) => member.identityId === this.agent.publicKey);
    const directMessage =
      Array.isArray(repositoryState.directParticipants) &&
      repositoryState.directParticipants.length === 2;
    await mkdir(this.options.cwd, { recursive: true });
    const selectionModel = configuration.model ?? this.options.config.modelSelection?.model;
    const selectionEffort = configuration.effort ?? this.options.config.modelSelection?.effort;
    const selection = {
      model: selectionModel,
      effort: selectionEffort,
      fastMode: configuration.fastMode,
    };
    const operatorHome = this.options.config.operatorHome ?? homedir();
    const registryHostDeclarations = registryMcpHostDeclarations(
      configuration.registryMcpRoutes,
      this.commandContext.path,
      this.options.config.registryMcpBrokerSocket,
    );
    const mountedHostRoutes = [...grantedHostRoutes, ...Object.keys(registryHostDeclarations)];
    const squireScope = {
      agentId: this.agent.publicKey,
      roomId: this.options.roomId,
      ...(grantedSquireHostRoute(mountedHostRoutes, {
        ...hostImportedMcpDeclarations({ operatorHome, agentKind: this.options.config.agentKind }),
        ...registryHostDeclarations,
      })
        ? { relay: await this.squireRelay.listen() }
        : {}),
    };
    const resourceAuthFile = `${this.commandContext.path}.resource-auth.json`;
    await mkdir(dirname(resourceAuthFile), { recursive: true, mode: 0o700 });
    await writeFile(
      resourceAuthFile,
      JSON.stringify({
        ...this.options.api.connection(),
        turnContextPath: this.commandContext.path,
      }),
      { mode: 0o600 },
    );
    const homeOverlay = this.options.config.agentHomeRoot
      ? await prepareRoomAgentHome({
          root: this.options.config.agentHomeRoot,
          squireScope,
          sharedSkills: this.options.config.sharedSkills ?? [],
          isReviewer: configuration.isReviewer === true,
          grantedHostRoutes: mountedHostRoutes,
          extraHostRoutes: registryHostDeclarations,
          resourceAuthFile,
          ...(this.options.config.agentEnv.PATH
            ? { inheritedPath: this.options.config.agentEnv.PATH }
            : {}),
          ...(this.options.config.agentKind ? { agentKind: this.options.config.agentKind } : {}),
          ...(this.options.config.operatorHome
            ? { operatorHome: this.options.config.operatorHome }
            : {}),
          ...openRouterRoutingInput(this.options.config, selection, this.options.fetchImpl, {
            ...(this.pinnedProviderOverride
              ? { providerOverride: this.pinnedProviderOverride }
              : {}),
            onDecision: (routing) => {
              // The override pins one provider; keep the full order it came
              // from so a later empty turn still knows what to rotate to.
              if (!this.pinnedProviderOverride) this.pinnedProviders = [...routing.providers];
              // A pinned model that takes no images is a fact about THIS
              // session (C87): the harness still advertises the capability,
              // so without this the turn would ship megabytes the model never
              // sees and say nothing about why (`modelTakesImages`).
              this.modelTakesImages = routing.input ? routing.input.includes('image') : undefined;
            },
          }),
        })
      : {};
    const command = this.options.config.agentCommand ?? this.options.config.agentBinary;
    const harnessLabel = harnessIdentityLabel({
      kind: this.options.config.agentKind,
      command,
    });
    const agentEnv = { ...this.options.config.agentEnv, ...homeOverlay };
    this.agentEnv = agentEnv;
    this.modelContextTokens = await modelContextWindowTokens(
      selectionModel,
      agentEnv.PI_CODING_AGENT_DIR,
    );
    const agentArgs = agentArgsWithModelSelection(
      {
        kind: this.options.config.agentKind,
        command,
        args: this.options.config.agentArgs ?? [],
      },
      selection,
    );
    const { stateDirs, tmpDir } = harnessStateDirsFromEnv(agentEnv);
    this.attachmentDir = tmpDir ? join(tmpDir, 'beeline-attachments') : undefined;
    this.sessionScratchDir = tmpDir;
    this.sessionStateDirs = stateDirs;
    const homeStateDirs = harnessHomeStateDirs(harnessLabel, agentEnv.HOME ?? operatorHome);
    await Promise.all(homeStateDirs.map((dir) => mkdir(dir, { recursive: true })));
    // The same path handed to the MCP server as BEELINE_ATTACH_SCRATCH_ROOT
    // (below): post_artifact can only post what write_scratch_file could write,
    // so the sandbox must leave this writable too.
    const attachScratchRoot = this.options.config.agentHomeRoot ?? tmpDir;
    if (attachScratchRoot) await mkdir(attachScratchRoot, { recursive: true });
    // Index before constructing the sandbox: a Room keeps the checkout
    // read-only, but CodeGraph's SQLite WAL and connect-time reconciliation
    // need its generated .codegraph directory writable while the MCP lives.
    const codegraphReady = await prepareCodegraphIndex(this.options.config, this.options.cwd);
    const fingerprint = sessionConfigFingerprint({
      devices: grantedDevices,
      model: configuration.model ?? this.options.config.modelSelection?.model,
      effort: configuration.effort ?? this.options.config.modelSelection?.effort,
      fastMode: configuration.fastMode,
      soul: configuration.soul ?? self?.soul,
      agentName: self?.name ?? this.agent.name,
      mcpServers: codegraphFingerprintServers(
        this.options.config,
        [
          ...expectedMountedImportedMcpServerNames({
            operatorHome: this.options.config.operatorHome,
            agentKind: this.options.config.agentKind,
            grantedHostRoutes: mountedHostRoutes,
          }),
          ...Object.keys(registryHostDeclarations),
        ],
        codegraphReady,
      ),
    });
    const spawnCommand = wrapAgentCommand({
      bwrapPath: this.options.config.bwrapPath,
      spec: {
        mode: 'readonly',
        cwd: this.options.cwd,
        harnessStateDirs: stateDirs,
        harnessHomeStateDirs: homeStateDirs,
        ...(tmpDir ? { tmpDir } : {}),
        additionalWritablePaths: [
          ...(attachScratchRoot ? [attachScratchRoot] : []),
          ...(codegraphReady ? [codegraphIndexDirectory(this.options.cwd)] : []),
          ...registryMcpHostBindPaths(
            configuration.registryMcpRoutes,
            this.options.config.registryMcpBrokerSocket,
          ),
          ...grantedSquireHostBindPaths({
            operatorHome,
            agentKind: this.options.config.agentKind,
            grantedHostRoutes: mountedHostRoutes,
          }),
        ],
        devices: grantedDevices,
        maskPaths: [
          ...credentialMaskPaths(this.options.config.sandboxMaskPaths, operatorHome),
          ...siblingAgentMaskPaths(
            runtimeDirectory(this.options.runtime.supervisorRoot, this.options.runtime.agent.publicKey),
          ),
        ],
      },
      command,
      args: agentArgs,
    });
    // Built before the client: the permission allowlist resolves a harness's
    // own tool-dispatch envelope (grok's `use_tool`) against exactly the
    // servers this session mounts, so it has to know them up front.
    const servers: McpServerWire[] = [
      readOnlyMcpServer(this.options.config, this.options.cwd),
      beelineAgentMcpServer(this.options.config, this.options.api, {
        roomId: this.options.roomId,
        workspaceId: this.options.workspaceId,
        attachRoot: this.options.cwd,
        // The whole per-session overlay, not an enumerated subset: the agent
        // never picks where a harness writes a file it generates (grok's own
        // images dir, say), so anything inside the overlay it could possibly
        // have written must be attachable, whatever subdirectory that is.
        attachScratchRoot,
        turnContextPath: this.commandContext.path,
        directMessage,
        squireRelay: squireScope.relay,
        ...(this.options.grantRunnerEndpoint && this.options.config.bwrapPath
          ? { grantRunner: this.options.grantRunnerEndpoint }
          : {}),
      }),
    ];
    if (codegraphReady) {
      const codegraph = codegraphMcpServer(this.options.config, this.options.cwd, {
        readonly: true,
      });
      if (codegraph) servers.push(codegraph);
    }
    const hostDeclarations = hostImportedMcpDeclarations({
      operatorHome,
      agentKind: this.options.config.agentKind,
    });
    const grantedRouteServers = grantedHostRouteWires(
      mountedHostRoutes,
      operatorHome,
      { ...hostDeclarations, ...registryHostDeclarations },
      resourceAuthFile,
      squireScope,
    );
    // Pi ACP ignores session/new MCP servers. The installer selects native
    // mcp.json or the generated bridge for this executable and isolated home.
    await installPiMcpBridge({
      agentCommand: harnessLabel,
      piHome: agentEnv.PI_CODING_AGENT_DIR,
      piCommand: agentEnv.PI_ACP_PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND,
      agentEnv,
      servers: [...servers, ...grantedRouteServers],
    });
    // What this session actually mounted, not only the Beeline-owned servers:
    // the isolated home also holds every copied local import and every granted
    // host route. A harness that names the tool but never the protocol (grok's
    // `use_tool` envelope) can only be resolved against this list, so a name
    // missing here is a mounted server the agent could never call.
    const mountedServers = [
      ...servers.map((server) => server.name),
      ...grantedRouteServers.map((server) => server.name),
      ...this.mountedMcpServers(agentEnv),
    ];
    const hostServers = ungatedHostServers(
      hostImportedMcpServerNames({
        operatorHome: this.options.config.operatorHome,
        agentKind: this.options.config.agentKind,
      }),
      mountedHostRoutes,
    );
    const clientOptions: ConstructorParameters<typeof AcpClient>[0] = {
      agentCommand: spawnCommand.command,
      agentArgs: spawnCommand.args,
      agentEnv,
      agentCwd: this.options.cwd,
      agentLabel: harnessLabel,
      // `bwrapPath` is set only when `detectBwrapSandbox` passed its self-test
      // (`config.ts`), which is exactly when `wrapAgentCommand` above wraps.
      osSandbox: Boolean(this.options.config.bwrapPath),
      autoApprovePermissions: false,
      permissionHandler: async (request) =>
        roomPermissionDecision(request, {
          mountedServers,
          hostServers,
          shellSandboxed: Boolean(this.options.config.bwrapPath),
        }),
      onCommands: agentCommandCatalogPublisher({
        api: this.options.api,
        agentId: this.agent.publicKey,
        workspaceId: this.options.workspaceId,
      }),
    };
    this.client = (this.options.createAcpClient ?? ((value) => new AcpClient(value)))(
      clientOptions,
    );
    await this.client.start();
    const persona = configuration.soul ?? self?.soul;
    const repositoryInfo =
      repositoryState.resolution === 'repository' && repositoryState.key
        ? {
            name: repositoryState.key,
            branch: repositoryState.targetBranch || 'main',
          }
        : undefined;
    // Whether this session runs shell commands is a fact about the harness AND
    // the sandbox: Codex executes them in its own read-only mode with no wrap at
    // all, while a harness that asks depends on the gate above. An unmeasured
    // harness states nothing (`roomShellCapability`).
    const shellCapability = roomShellCapability(harnessLabel, {
      osSandbox: Boolean(this.options.config.bwrapPath),
    });
    const session = assembleSessionPrompt({
      surface: directMessage ? 'dm' : 'room',
      agentName: self?.name ?? this.agent.name,
      ...(persona?.instructions
        ? { soul: { name: persona.name, instructions: persona.instructions } }
        : {}),
      agentCommand: command,
      ...(repositoryInfo ? { repository: repositoryInfo } : {}),
      ...(shellCapability === 'runs'
        ? { shell: { available: true } as const }
        : shellCapability === 'refused'
          ? {
              shell: {
                available: false,
                ...(this.options.config.shellUnavailableDetail
                  ? { detail: this.options.config.shellUnavailableDetail }
                  : {}),
              } as const,
            }
          : {}),
    });
    this.sessionSurface = directMessage ? 'dm' : 'room';
    this.turnInstructionPrefix = session.turnPrefix;
    this.sessionPromptSectionIds = session.report.map((section) => section.id);
    const opened = await this.client.sessionNew({
      cwd: this.options.cwd,
      mcpServers: servers,
      mode: 'readonly',
      systemPrompt: session.systemPrompt,
    });
    this.sessionId = opened.sessionId;
    this.sessionCwd = this.options.cwd;
    this.sessionCommit = this.turnCheckout?.commit;
    this.sessionFingerprint = fingerprint;
    this.sessionCodegraphReady = codegraphReady;
    if (selection) {
      const options = filterAllowedModelConfigOptions(
        parseAdvertisedConfigOptions(opened.raw, selection.model),
      );
      const applied = await applyAgentModelSelection(this.client, opened.sessionId, options, selection);
      if (
        selection.model &&
        applied.appliedSelection.model &&
        applied.appliedSelection.model !== selection.model
      ) {
        this.recordModelFallback(applied.appliedSelection, applied.options);
      }
    }
    return opened.sessionId;
  }

  /**
   * A vanished model id was just substituted for a same-family replacement
   * (`resolveModelFamilyFallback`) so THIS turn could proceed instead of
   * failing it. Persist the correction so the phone stops offering the dead
   * id and the durable `model_unavailable` flag stays clear, and let the
   * server (`daemon-service.ts`'s `modelCatalog`) name the change in the
   * agent's DM — fire-and-forget: a slow or failed report must never hold up
   * or fail a turn that already succeeded with the fallback model applied.
   */
  private recordModelFallback(
    appliedSelection: { model?: string; effort?: string },
    options: AgentModelConfigOption[],
  ): void {
    this.options.api
      .execute('postAgentModelCatalog', {
        agentId: this.agent.publicKey,
        workspaceId: this.options.workspaceId,
        options: options as DaemonOperationMap['postAgentModelCatalog']['input']['options'],
        selection: appliedSelection,
      })
      .catch((error) =>
        console.error(
          `[thin-core] failed to persist automatic model fallback for Room ${this.options.roomId}:`,
          error,
        ),
      );
  }

  /**
   * The scheduler seam, and the only place that can see the boundary between
   * waiting for a slot and spawning a harness: `queue-wait` closes the instant
   * `activate()` is called, and `cold` vs `warm` is decided by whether this
   * Room already holds a live ACP client.
   */
  private lifecycle(trace?: TurnTrace): SessionLifecycle {
    return {
      activate: async () => {
        trace?.end('queue-wait');
        // `cold` is noted inside activate() rather than guessed here: the
        // scheduler calls this for a fresh process AND after it retires a
        // stale retained one, and the trace has to say what happened.
        return trace ? trace.measure('activation', () => this.activate(trace)) : this.activate();
      },
      isCurrent: () => {
        // The scheduler is about to hand back a retained process; this is the
        // only moment its configuration can be re-checked, so the wait for a
        // slot ends here exactly as it does for a spawn.
        trace?.end('queue-wait');
        const check = () => this.sessionIsCurrent();
        return trace ? trace.measure('activation', check) : check();
      },
      onStateChange: (state) => {
        if (state === 'waiting-for-slot') trace?.noteCapacityWait();
      },
      suspend: () => this.discardSession(),
    };
  }

  /** The pinned providers a failure reason should name for this session. */
  private servingProviders(): string[] {
    return this.pinnedProviderOverride ? [this.pinnedProviderOverride] : this.pinnedProviders;
  }

  /** Why a turn carried no answer text, or undefined when it did. */
  private async explainEmpty(result: PromptResult): Promise<EmptyTurnExplanation | undefined> {
    if (durableReplyText(result.agentText)) return undefined;
    return explainEmptyAgentTurn({
      agentLabel: harnessIdentityLabel({
        kind: this.options.config.agentKind,
        command: this.options.config.agentCommand ?? this.options.config.agentBinary,
      }),
      agentEnv: this.agentEnv,
      sessionId: this.sessionId!,
      result,
    });
  }

  /**
   * Re-pin the session to the next provider in the OpenRouter order and open a
   * fresh session on it, so the retry of an empty completion or a failing
   * provider is served — and named — by exactly one provider. Undefined when
   * the pin has nowhere left to go.
   */
  private async repinNextProvider(trace?: TurnTrace, reason?: string): Promise<string | undefined> {
    const next = nextPinnedProvider(this.pinnedProviders, this.pinnedProviderOverride);
    if (!next) return undefined;
    // The retry is its own timeline: everything from here — the fresh ACP
    // handshake included — belongs to attempt two, never to attempt one's
    // first-token time.
    trace?.retry({ provider: next, ...(reason ? { reason } : {}) });
    const client = this.client;
    this.client = undefined;
    this.sessionId = undefined;
    this.sessionFingerprint = undefined;
    this.sessionCodegraphReady = false;
    if (client?.isAlive) await client.stop();
    this.pinnedProviderOverride = next;
    await (trace ? trace.measure('activation', () => this.activate(trace)) : this.activate());
    return next;
  }

  private startPrompt(item: HumanMessage): void {
    const active: ActiveTurn = {
      item,
      steers: [],
      steerTail: Promise.resolve(),
      resumeRequested: false,
      cancelled: false,
      phase: 'prompting',
      promise: Promise.resolve(),
    };
    this.activeTurn = active;
    active.promise = this.prompt(active)
      .catch((error) => {
        console.error(`[thin-core] monolith Room ${this.options.roomId} turn failed:`, error);
      })
      .finally(() => {
        if (this.activeTurn === active) {
          this.activeTurn = undefined;
          this.wakeIntake?.();
          this.wakeIntake = undefined;
        }
      });
  }

  /**
   * Obey a stop the requester already made a fact.
   *
   * A stop names ONE request id and touches only the turn that answers it. The
   * turn in flight is cancelled at the harness and marked so its own run
   * publishes nothing; a turn still queued is simply dropped, since starting
   * work the person has already withdrawn is worse than never starting it.
   * A stop for neither is ignored — it belongs to a turn that ended between
   * the press and the delivery, and the server's own receipt already said so.
   */
  private stopTurn(requestId: string): void {
    if (this.pausedOnGrantRequestId === requestId) {
      this.pausedOnGrantRequestId = undefined;
      this.pausedOnGrantKind = undefined;
    }
    this.squireRelay.cancel(requestId);
    for (let index = this.queuedTurns.length - 1; index >= 0; index -= 1)
      if (this.queuedTurns[index]!.id === requestId) this.queuedTurns.splice(index, 1);
    const active = this.activeTurn;
    if (!active || active.item.id !== requestId) return;
    active.cancelled = true;
    if (this.client && this.sessionId) this.client.sessionCancel(this.sessionId);
  }

  private async prompt(active: ActiveTurn): Promise<void> {
    const { item } = active;
    const api = this.options.api;
    // Admission is busy before the first awaited receipt write. The updater
    // cannot observe an accepted/queued turn as idle in this window.
    this.busy = true;
    // A turn starts with no measured cost. Without this reset a turn that throws
    // before its own prompt settles — the context fetch, `buildPrompt`, a
    // rejected delivery — would report the PREVIOUS turn's token count and
    // prompt size on its failure receipt, and the budget gate would read a
    // number belonging to somebody else's prompt.
    this.turnMetrics = {};
    this.turnUsage = new TurnUsageAccumulator();
    const trace = this.beginTurnTrace(item.id);
    // Kicked off now, alongside activation rather than after it, so its own
    // network round trip has somewhere to hide (see institutional-context.ts).
    const institutionalContextFetch = startInstitutionalContextFetch(api, this.options.roomId);
    // Best-effort read of this turn's search_memory call/miss counters before
    // the trace writes — bounded so a slow or unreachable server never delays
    // the turn's own completion over a diagnostic.
    let statsStartedAt = 0;
    let statsPromise: Promise<{ searchCalls: number; searchMisses: number } | undefined> | undefined;
    const startTraceStats = (): void => {
      if (statsPromise) return;
      statsStartedAt = Date.now();
      statsPromise = api.execute('getInstitutionalMemoryTurnStats', {
        roomId: this.options.roomId,
        agentId: this.agent.publicKey,
        requestId: item.id,
      }).catch(() => undefined);
    };
    const finishTrace = async (
      outcome: 'complete' | 'failed' | 'cancelled',
      reason?: string,
    ): Promise<void> => {
      try {
        const remaining = Math.max(0, 800 - (Date.now() - statsStartedAt));
        let timer: NodeJS.Timeout | undefined;
        const stats = statsPromise && remaining > 0
          ? await Promise.race([
              statsPromise,
              new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), remaining); }),
            ]).finally(() => { if (timer) clearTimeout(timer); })
          : undefined;
        if (stats) trace.noteSearchMemoryStats(stats.searchCalls, stats.searchMisses);
      } catch {
        // Losing this measurement must never affect the turn.
      }
      await trace.finish(outcome, reason);
    };
    // The draft lane, held where the catch below can reach it: a turn that
    // throws never reaches its settle, and only this reference can dissolve
    // what the model had already written.
    let liveStream: AgentTurnStream | undefined;
    // Corner-opened observed LIVE from the stream, held where the catch below
    // can reach it, not only read from the final result: a timeout thrown out
    // of runPrompt() never produces a result, so the success path's
    // `openedACorner` check alone cannot see that the work already moved to
    // the corner.
    let liveCornerOpened = false;
    try {
      // The first row of the turn names who asked; learn the name once per session.
      if (!this.memberNames.has(item.authorId)) await this.roster().catch(() => undefined);
      await withTurnReceiptHeartbeat(
        api,
        {
          agentId: this.agent.publicKey,
          roomId: this.options.roomId,
          requestId: item.id,
          generationId: this.commandContext.generationId,
        },
        async () => {
          await api.execute('postAgentActivity', {
            agentId: this.agent.publicKey,
            roomId: this.options.roomId,
            requestId: item.id,
            activity: [
              {
                kind: 'thinking',
                title: 'Working',
                status: 'in_progress',
                requestedBy: this.requesterOf(item.authorId),
              },
            ],
          });
          trace.noteScheduler('queue', this.options.scheduler.snapshot());
          trace.start('queue-wait');
          this.turnCheckout = undefined;
          await this.options.scheduler.run(
            this.options.roomId,
            this.lifecycle(trace),
            async () => {
              // Belt and braces: `activate`/`isCurrent` already closed the
              // queue wait, and `end` on a closed phase is a no-op.
              trace.end('queue-wait');
              trace.noteScheduler('admission', this.options.scheduler.snapshot());
              if (this.options.refreshCheckout && !this.turnCheckout) {
                throw new Error('Room checkout refresh failed before this turn');
              }
              const checkout = this.turnCheckout;
              const [conversation, roster, delivered, corners, institutionalContext] =
                await trace.measure('context-fetch', () =>
                  Promise.all([
                    api.execute('getRoomConversation', { roomId: this.options.roomId, limit: 200 }),
                    this.roster(),
                    this.deliver(item),
                    api.execute('listRoomCorners', { roomId: this.options.roomId }),
                    awaitInstitutionalContext(institutionalContextFetch, (message) =>
                      console.warn(`[thin-core] Room ${this.options.roomId}: ${message}`),
                    ),
                  ]),
                );
              trace.noteInstitutionalMemory(institutionalContext.outcome);
              if (institutionalContext.embeddingOutcome !== undefined) {
                trace.noteInstitutionalMemoryEmbedding(
                  institutionalContext.embeddingOutcome,
                  institutionalContext.embeddingMs ?? 0,
                );
              }
              const names = new Map(
                roster.members.map((member) => [member.identityId, member.name]),
              );
              const transcriptRows = conversation.items
                .filter(
                  (message) =>
                    message.type === 'message' &&
                    message.id !== item.id &&
                    !active.steers.some((steerItem) => steerItem.id === message.id),
                )
                .slice(-80)
                .map((message) => ({
                  id: message.id,
                  authorId: message.authorId,
                  line: transcriptMessagePrompt(
                    names.get(message.authorId) ?? message.authorId.slice(0, 12),
                    message.body,
                    message.attachments,
                    message.id,
                  ),
                }));
              const command = this.commandContext.current;
              const grantDecision = command?.action === 'resume';
              const decisionKind = command?.source.systemEvent?.kind;
              const decisionResume = grantDecision &&
                command.turnRequestId === this.pausedOnGrantRequestId &&
                ((decisionKind === 'grant-decided' && this.pausedOnGrantKind === 'grant') ||
                  (decisionKind === 'connector-offer-decided' && this.pausedOnGrantKind === 'connector'));
              const resumedRequestId = decisionResume ? this.pausedOnGrantRequestId : undefined;
              if (decisionResume) {
                this.pausedOnGrantRequestId = undefined;
                this.pausedOnGrantKind = undefined;
              }
              // Built per ATTEMPT, never once per turn: a C92 re-pin runs the
              // same turn against a NEW session id that holds none of this
              // conversation, so it has to render the whole window again.
              const openCorners = (corners.corners ?? []).filter((corner) => !corner.archived);
              const closedSince = Math.floor(Date.now() / 1_000) - 24 * 60 * 60;
              const closedCorners = (corners.corners ?? [])
                .filter(
                  (corner) =>
                    corner.archived &&
                    corner.closedAt !== undefined &&
                    corner.closedAt >= closedSince,
                )
                .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
              let deviceResume: string | undefined;
              const buildPrompt = (): string => {
                const transcript = this.warmTranscript.select(
                  this.sessionId,
                  transcriptRows,
                  this.agent.publicKey,
                );
                const assembled = assembleTurnPrompt({
                  surface: this.sessionSurface,
                  modelContextTokens: this.modelContextTokens,
                  sessionPrefix: this.turnInstructionPrefix,
                  ...(checkout?.branch && checkout.commit
                    ? { checkout: { branch: checkout.branch, commit: checkout.commit } }
                    : {}),
                  transcript: {
                    lines: transcript.rows.map((row) => row.line),
                    sinceLastTurn: transcript.warm,
                  },
                  ...(deviceResume
                    ? { resume: deviceResume }
                    : grantDecision
                      ? { resume: resumePrompt(item) }
                      : {}),
                  members: roomMentionDirectory(roster, this.agent.publicKey),
                  memory: institutionalContext.text,
                  corners: openCorners,
                  closedCorners,
                  task: {
                    fromName: inboxItemAuthorName(item, names),
                    ...(item.cornerAskId ? { cornerAskId: item.cornerAskId } : {}),
                    body: roomMessagePrompt(
                      '',
                      inboxItemPromptBody(item),
                      item.attachments,
                      delivered,
                      this.acceptsImages(),
                      item.type === 'message' ? item.id : undefined,
                    ),
                  },
                });
                trace.notePromptSections(assembled.report);
                trace.notePromptWindow(assembled.text, this.modelContextTokens);
                this.commandContext.notePromptSections([
                  ...this.sessionPromptSectionIds,
                  ...assembled.report.map((section) => section.id),
                ]);
                return assembled.text;
              };
              // Rooms and corners stream through ONE presentation (C100): the
              // provisional draft lane, the request-id handoff, and the single
              // durable reply that dissolves it all live in `turn-stream.ts`.
              const stream = new AgentTurnStream({
                api,
                agentId: this.agent.publicKey,
                roomId: this.options.roomId,
                requestId: item.id,
                label: `monolith Room ${this.options.roomId}`,
              });
              liveStream = stream;
              // One prompt run, steers and all. It is a closure because an empty
              // completion re-pins the session to another provider and runs it
              // again (C92) — against the NEW client and session id.
              let loginRetryUsed = false;
              const runPrompt = async (): Promise<PromptResult> => {
                let nextPrompt = promptWithImages(
                  buildPrompt(),
                  attachmentImageBlocks(delivered, this.acceptsImages()),
                );
                let result: Awaited<ReturnType<AcpClient['sessionPrompt']>> | undefined;
                for (;;) {
                  let promptError: unknown;
                  try {
                    stream.beginRun();
                    trace.promptSent();
                    result = await this.turnUsage.measure(
                      { agentEnv: this.agentEnv, sessionId: this.sessionId! },
                      () =>
                        this.client!.sessionPrompt(
                          this.sessionId!,
                          nextPrompt,
                          ROOM_PROMPT_BACKSTOP_MS,
                          (delta, full, currentRun) => {
                            trace.firstModelOutput();
                            stream.onChunk(delta, full, currentRun);
                          },
                          undefined,
                          (calls) => {
                            trace.toolCalls(calls);
                            if (openedACorner(openCornerToolCall(calls))) liveCornerOpened = true;
                          },
                        ),
                    );
                  } catch (error) {
                    promptError = error;
                  }
                  this.turnMetrics = await this.captureTurnMetrics();
                  await this.writeBackClaudeLogin();
                  const settledSteerTail = active.steerTail;
                  await settledSteerTail;
                  if (settledSteerTail !== active.steerTail) continue;
                  if (promptError && isExpiredHarnessLoginError(promptError)) {
                    if (!loginRetryUsed) {
                      loginRetryUsed = true;
                      console.warn(
                        `[thin-core] monolith Room ${this.options.roomId} turn ${item.id}: ` +
                          'harness login expired; repairing the shared credential and retrying once',
                      );
                      trace.retry({ reason: 'expired harness login' });
                      if (this.options.config.agentHomeRoot) {
                        await repairRoomAgentCredentialLinks({
                          root: this.options.config.agentHomeRoot,
                          operatorHome: this.options.config.operatorHome,
                        });
                      }
                      await this.discardSession();
                      await trace.measure('activation', () => this.activate(trace));
                      continue;
                    }
                    return {
                      stopReason: 'login-required',
                      updates: [],
                      agentText: freshHarnessLoginLine(this.options.config.agentKind, hostname()),
                      toolCalls: [],
                    };
                  }
                  if (!active.resumeRequested) {
                    if (promptError) throw promptError;
                    break;
                  }
                  active.resumeRequested = false;
                  nextPrompt = [
                    'The previous run was cancelled because its harness could not accept every live steer.',
                    'Resume the same turn. Keep the original request and everything that happened before it was cancelled.',
                    'Human messages that arrived after the original request, in transcript order:',
                    ...active.steers.map((steerItem) =>
                      roomMessagePrompt(
                        steerItem.authorId.slice(0, 12),
                        steerItem.body,
                        steerItem.attachments,
                        this.deliveredAttachments.get(steerItem.id),
                        this.acceptsImages(),
                        steerItem.type === 'message' ? steerItem.id : undefined,
                      ),
                    ),
                    'Continue now and answer the updated request without erasing the earlier context.',
                  ].join('\n\n');
                }
                return result!;
              };
              let result = await runPrompt();
              trace.promptSettled();
              // An instantly approved device grant cannot reach the running
              // sandbox: replace the session and continue this same turn there.
              const grantedDevice = approvedDeviceGrant(result.toolCalls);
              if (grantedDevice) {
                trace.retry({ reason: 'device grant' });
                if (!(await this.sessionIsCurrent())) {
                  await this.discardSession();
                  await trace.measure('activation', () => this.activate(trace));
                }
                deviceResume = deviceGrantResumePrompt(grantedDevice, result.agentText);
                result = await runPrompt();
                trace.promptSettled();
              }
              let openCornerCall = openCornerToolCall(result.toolCalls);
              let cornerOpened = openedACorner(openCornerCall);
              let explained = await this.explainEmpty(result);
              // A stopped turn ends `aborted` with no text; that is the
              // requester's answer, not a routing failure, and must not re-pin
              // the session. A provider's 429/5xx moves the pin onward.
              if (
                !cornerOpened &&
                !active.cancelled &&
                explained &&
                (shouldRetryEmptyTurn(explained) || shouldFailOverProviderError(explained))
              ) {
                const silent = this.servingProviders();
                const next = await this.repinNextProvider(trace, explained.reason);
                if (next) {
                  console.warn(
                    `[thin-core] monolith Room ${this.options.roomId} turn ${item.id}: ` +
                      `${turnFailureReasonWithProvider(explained.reason, silent)}; retrying on ${next}`,
                  );
                  result = await runPrompt();
                  trace.promptSettled();
                  openCornerCall = openCornerToolCall(result.toolCalls);
                  cornerOpened = openedACorner(openCornerCall);
                  explained = await this.explainEmpty(result);
                }
              }
              // A session whose history outgrew the model's window refuses
              // every retry inside it. One retry in a fresh session; a second
              // overflow fails the turn as `context-overflow`, never a hiccup.
              if (!cornerOpened && explained && isContextOverflowTurn(explained)) {
                console.warn(
                  `[thin-core] monolith Room ${this.options.roomId} turn ${item.id}: ` +
                    `${explained.reason}; retrying once in a fresh session`,
                );
                trace.retry({ reason: 'context overflow' });
                await this.discardSession();
                await trace.measure('activation', () => this.activate(trace));
                result = await runPrompt();
                trace.promptSettled();
                openCornerCall = openCornerToolCall(result.toolCalls);
                cornerOpened = openedACorner(openCornerCall);
                explained = await this.explainEmpty(result);
              }
              // The requester stopped this turn while it ran. A stopped turn
              // publishes nothing at all — no durable reply, no receipt, and no
              // late write of any kind: the server settled the turn `cancelled`
              // and wrote the attributed line before this helper even heard,
              // and that line is the Room's whole record of the stop.
              if (active.cancelled) {
                stream.close();
                throw new TurnStoppedError('turn stopped by the requester');
              }
              active.phase = 'finishing';
              const pendingCard = result.toolCalls.map((call) => pendingCardKind(call)).find(Boolean);
              if (pendingCard) {
                this.pausedOnGrantRequestId = item.id;
                this.pausedOnGrantKind = pendingCard;
                console.log(
                  `[thin-core] monolith Room ${this.options.roomId} turn ${item.id} paused on a grant card`,
                );
              } else if (resumedRequestId) {
                console.log(
                  `[thin-core] monolith Room ${this.options.roomId} turn ${resumedRequestId} resumed by card decision ${item.id}`,
                );
              }
              if (openCornerCall) {
                console.log(
                  `[thin-core] monolith Room ${this.options.roomId} tool call: ${openCornerCall.title} (${openCornerCall.status ?? 'no status'})`,
                );
                if (cornerOpened) this.options.onCornerOpened?.();
              }
              // A refusal the operator cannot read is a refusal that happens twice.
              for (const call of result?.toolCalls ?? []) {
                const failure = toolCallFailureLine(call);
                if (failure) {
                  console.warn(`[thin-core] monolith Room ${this.options.roomId} ${failure}`);
                }
              }
              // Close the draft lane before the answer is published: the finished
              // reply must never queue behind a draft nobody will read.
              stream.close();
              let reply = durableReplyText(result.agentText);
              if (!reply && explained?.recoveredText) {
                // Text the harness recorded but never streamed. Kept on a
                // corner-open turn too: it is the same reply the live lane
                // would have shown, arriving only at settle. Sanitized first,
                // because a recovered string that is only harness preamble or
                // the scaffold echo leaves nothing to say.
                reply = durableReplyText(explained.recoveredText);
              }
              if (!reply && explained && !cornerOpened) {
                // A named reason (pi's provider refusal, an empty model answer,
                // the stream's shape) carrying the provider that served the
                // turn — never the bare "no reply" as the only fact. A corner
                // that already opened is the Room's completion even without
                // prose; do not fail that turn for emptiness.
                throw new Error(
                  turnFailureReasonWithProvider(explained.reason, this.servingProviders()),
                );
              }
              if (reply && explained) {
                console.warn(
                  `[thin-core] monolith Room ${this.options.roomId} turn ${item.id}: ${explained.reason}`,
                );
              }
              // The server's corner-open card and this reply are one
              // completion: live prefixes of the same text, then that text
              // written durably. An empty last run still settles through the
              // card alone. Silence waits for `completed`, never merely for
              // "not failed".
              await trace.measure('publish', () =>
                stream.settle(
                  reply,
                  reply
                    ? {
                        triggerMessageId: item.id,
                      }
                    : {},
                ),
              );
            },
            { priority: 'interactive', roomKey: this.options.roomId },
          );
        },
        (error) =>
          console.error(
            `[thin-core] monolith Room ${this.options.roomId} receipt heartbeat failed:`,
            error,
          ),
        () => {
          console.warn(
            `[thin-core] monolith Room ${this.options.roomId} turn ${item.id} dropped: ` +
              'the server revoked its output authority',
          );
          this.stopTurn(item.id);
        },
      );
      startTraceStats();
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
        requestId: item.id,
        status: 'complete',
        generationId: this.commandContext.generationId,
        toolCalls: trace.toolCallsTotal,
        ...this.turnMetrics,
      });
      // After the receipt: an operator artifact must never delay the answer,
      // and it never becomes one — the trace has no way to post a Room row.
      void finishTrace('complete').catch(() => undefined);
    } catch (error) {
      // A stopped turn already has its ending — the server wrote `cancelled`
      // and named who stopped it the moment it accepted the request. There is
      // no receipt to post and nothing to blame the helper for, so the turn
      // ends here quietly and only the operator's trace records it. It is also
      // the one throw that retracts nothing: a stopped turn writes NOTHING
      // after its authority ended, and the server stops serving that turn's
      // draft the moment it settles the turn `cancelled` (`liveDraftSnapshot`
      // reads working turns only).
      if (error instanceof TurnStoppedError || active.cancelled) {
        console.log(
          `[thin-core] monolith Room ${this.options.roomId} turn ${item.id} stopped by the requester`,
        );
        void finishTrace('cancelled').catch(() => undefined);
        return;
      }
      // A backstop after opening a corner settles the Room reply through
      // the existing corner card. Runtime and provider errors still fail.
      if (liveCornerOpened && error instanceof AcpTurnBackstopError) {
        console.log(
          `[thin-core] monolith Room ${this.options.roomId} turn ${item.id}: ` +
            'turn_backstop after opening a corner; the work continues in the corner',
        );
        this.options.onCornerOpened?.();
        // The prose the reader watched arrive is the same completion as the
        // card, and the `complete` receipt below ends the draft either way, so
        // settling it here is what keeps it on the page. It is the LAST run
        // alone — what `result.agentText` would have carried had the prompt
        // returned — never the joined stream, so a turn's durable answer does
        // not depend on whether it wedged. A last run that is retry narration
        // or sanitizes away settles through the card alone.
        const lastRun = liveStream?.lastRunText ?? '';
        const streamed = isPureRetryNarration(lastRun) ? '' : durableReplyText(lastRun);
        if (liveStream) {
          await liveStream
            .settle(streamed, streamed ? { triggerMessageId: item.id } : {})
            .catch((settleError: unknown) => {
              console.error(
                `[thin-core] monolith Room ${this.options.roomId} draft settle failed:`,
                settleError,
              );
            });
          // `settle` posts the reply before it retracts, so a refused reply
          // throws past its own retract and leaves the draft live under a turn
          // this arm is about to report complete. The retract is idempotent.
          await liveStream.retract();
        }
        startTraceStats();
        await api.execute('postAgentTurnReceipt', {
          agentId: this.agent.publicKey,
          roomId: this.options.roomId,
          requestId: item.id,
          status: 'complete',
          generationId: this.commandContext.generationId,
          toolCalls: trace.toolCallsTotal,
          ...this.turnMetrics,
        });
        void finishTrace('complete').catch(() => undefined);
        return;
      }
      // A failed turn ends owning no live output. Only `settle` dissolves the
      // draft on the way out and a throw never reaches one, so without this the
      // last snapshot the model streamed stays live under a turn the Room has
      // already reported failed — still pulsing, still claiming to be an answer
      // on its way. The retract settles that row in place: the words the person
      // was reading stay, and stop pretending to be in progress. Its own
      // failure must never replace the error that actually ended the turn.
      await liveStream?.retract().catch((retractError: unknown) => {
        console.error(
          `[thin-core] monolith Room ${this.options.roomId} draft retract failed:`,
          retractError,
        );
      });
      const reason = distillTurnFailureReason(error);
      startTraceStats();
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
        requestId: item.id,
        status: 'failed',
        generationId: this.commandContext.generationId,
        reason: reason.text,
        ...(reason.kind ? { reasonKind: reason.kind } : {}),
        toolCalls: trace.toolCallsTotal,
        ...this.turnMetrics,
      });
      void finishTrace('failed', reason.text).catch(() => undefined);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async run(): Promise<void> {
    const { api, roomId, signal, supervisor } = this.options;
    const intake = (progress: () => void) =>
      runServerCommandIntake({
        api,
        roomId,
        agentId: this.agent.publicKey,
        context: this.commandContext,
        signal,
        pollMs: this.options.pollMs,
        presence: {
          ...(this.options.config.daemonReleaseVersion
            ? { releaseVersion: this.options.config.daemonReleaseVersion }
            : {}),
          ...(this.options.config.daemonSourceSha
            ? { sourceSha: this.options.config.daemonSourceSha }
            : {}),
          available: !this.options.config.modelUnavailable,
        },
        onWake: (wake) => {
          this.wakeIntake = wake;
        },
        onPoll: () => {
          progress();
          this.options.health.poll();
        },
        onSubscriptionState: this.options.onSubscriptionState,
        onError: (error) => {
          this.options.onIntakeError?.(error);
          console.error('[thin-core] Room command failed', error);
        },
        // Marks this loop busy the instant it attempts to claim a real
        // turn, before the claim's own network round trip and before
        // context.enter()'s own file I/O - closing the window where
        // RoomRuntimeCoordinator.reconcile's repository-revision restart
        // could see a claiming-but-not-yet-`busy` Room as idle and stop it,
        // cancelling a turn that had already begun (or was about to) (C112).
        onClaiming: () => {
          this.busy = true;
        },
        onClaimFailed: () => {
          this.busy = false;
        },
        onEnter: (command) => this.squireRelay.activate(command, this.commandContext.generationId),
        onLeave: (command) =>
          this.squireRelay.deactivate(command.turnRequestId, this.pausedOnGrantRequestId),
        stop: (requestId) => this.stopTurn(requestId),
        restart: () => this.options.onRestartRequested?.(),
        canStartTurn: this.options.canStartTurn,
        run: async (command) => {
          const item = {
            ...command.source,
            id: command.turnRequestId,
            body:
              command.action === 'resume'
                ? `Resume the paused turn. The server supplied this answer: ${command.source.body}`
                : command.source.body,
          };
          this.startPrompt(item);
          await this.activeTurn?.promise;
        },
      });
    try {
      await (supervisor
        ? supervisor.supervise(`Room ${roomId}`, signal, intake)
        : intake(() => undefined));
    } finally {
      this.squireRelay.close();
      this.options.grantRunner?.unregister(roomId);
      await this.options.scheduler.suspend(roomId);
    }
  }
}

/** This turn's `open_corner` call, under whatever prefix the harness titles it. */
function openCornerToolCall(calls: readonly ToolCallEntry[]): ToolCallEntry | undefined {
  return calls.find((call) => /(?:^|[._:/-])open_corner$/i.test(call.title ?? ''));
}

/**
 * True only for a corner this turn actually opened.
 *
 * A completed open is what lets a textless turn settle through the card alone,
 * and what excuses the empty-turn retry and the turn backstop, so it asks
 * the harness for an affirmative `completed` and accepts nothing weaker. A call
 * still `pending` when the turn ended, or carrying no status at all, opened no
 * corner: read as success it would let a turn that said nothing pass as
 * answered by a card that never comes.
 */
function openedACorner(call: ToolCallEntry | undefined): boolean {
  return !!call && isCompletedToolCall(call);
}

/**
 * An earlier transcript message: its attachments are markers the agent can
 * pass to download_attachment, never a download made while building the prompt.
 */
function transcriptMessagePrompt(
  author: string,
  body: string,
  attachments: RoomMessage['attachments'],
  messageId: string,
): string {
  return [
    `[message id: ${messageId}]`,
    `${author}: ${body.trim() || '(shared attachments)'}`,
    ...attachmentMarkerLines(attachments),
  ].join('\n');
}

function roomMessagePrompt(
  author: string,
  body: string,
  attachments: RoomMessage['attachments'],
  delivered?: readonly DeliveredAttachment[],
  harnessAcceptsImages = true,
  messageId?: string,
): string {
  const message = body.trim() || '(shared attachments)';
  const rendered = author ? `${author}: ${message}` : message;
  return [
    ...(messageId ? [`[message id: ${messageId}]`] : []),
    rendered,
    ...attachmentPromptLines(attachments, delivered, harnessAcceptsImages),
  ].join('\n');
}
