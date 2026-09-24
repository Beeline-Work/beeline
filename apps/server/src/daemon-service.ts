import {
  authorizeCommandOutput,
  authorizeFailedTurnOutput,
  claimAgentCommand,
  commandInbox,
  createAgentCommand,
  queueCornerWorkerAfterReview,
  readAgentCommands,
  routeAgentResult,
  routeSystemCommand,
  turnRootMessageSql,
  type CommandRow,
} from './agent-command.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  DaemonAttachment,
  DaemonOperationMap,
  SystemEvent,
} from '@beeline/api-contract/daemon';
import { recordCornerMergeApproval } from './corner-merge-approval.js';
import {
  AGENT_TO_AGENT_HOP_CAP,
  classifyTurnSilence,
  cornerTextRefusal,
  readCornerAppDefinition,
  normalizeCornerText,
  shouldCompletePendingFailedCommand,
} from '@beeline/api-contract/daemon';
import {
  MAX_EVENT_CONSEQUENCE_LENGTH,
  MAX_MENTIONS_PER_EVENT,
  SERVER_EVENT_KINDS,
  isAgentKind,
  isServerEventKind,
  MESSAGE_REACTION_EMOJIS,
  type ServerEventKind,
} from '@beeline/api-contract/phone';
import {
  AGENT_GRANT_REASON_MAX_LENGTH,
  AGENT_GRANT_TARGET_MAX_LENGTH,
  GRANT_SCRIPT_MAX_BYTES,
  GRANT_SCRIPT_MAX_LINES,
  commandRuleEscalations,
  grantScriptTooLongMessage,
  interpreterScriptArgument,
  isAgentGrantKind,
  isCommandGrantScript,
  parseCommandGrantTarget,
  squireCallAllowed,
  type AgentGrantEscalation,
  type AgentGrantKind,
  type CommandGrantRule,
  type CommandGrantScript,
} from '@beeline/api-contract/agent-grants';
import {
  surfaceForRoom,
  surfaceGrantBoundary,
  type AgentSurface,
} from '@beeline/api-contract/surface-capabilities';
import { nextScheduleOccurrence, validateScheduleCadence } from './agent-schedules.js';
import { MESSAGE_CURSOR_MS_SQL, type SqlDatabase } from './database.js';
import { closeCornerState } from './corner-close.js';
import {
  LiveHub,
  type CommittedMessageLiveRow,
  type CommittedTurnLiveRow,
  type LiveEvent,
} from './live.js';
import { CORNER_WAKE_MIN_INTERVAL_MS, CORNER_WAKE_TIMEOUT_MS, wakesCorner } from './corner-wake.js';
import {
  restateSystemLine,
  systemIdentityMention,
  systemLine,
  type SystemPhrase,
} from './system-line.js';
import { mediaIdFromUrl } from './media-ttl.js';
import { postRoomChoice } from './room-choice.js';
import { connectorAdapter } from '@beeline/api-contract/workbench';
import {
  applyVaultList,
  connectorCatalog,
  connectorDisplayName,
  connectorIdentityId,
  ensureConnectorDirectMessageRoom,
  isMetadataStale,
  receiveConnectionUsage,
} from './workbench.js';
import type {
  ConnectorAssignment,
  ConnectorKind,
  ConnectorStatus,
  ConnectorStep,
} from '@beeline/api-contract/workbench';
import {
  CONNECTOR_OFFER_REASON_MAX_LENGTH,
  connectorOfferConsequence,
  connectorPurpose,
  isOfferableConnectorKind,
  type ConnectorOfferCardView,
} from '@beeline/api-contract/connector-offers';
import {
  AGENT_REACHABLE_HORIZON_MS,
  parseAgentAccessPolicy,
  senderMayAddressAgent,
} from '@beeline/api-contract/agent-access';
import { taggedIdentityIdsSql, typedMentionHandles } from './message-mentions.js';
import { agentWalletTool } from './wallet.js';
import {
  noteFirstSilence,
  TURN_FAILURE_REASON_MAX,
  turnSilenceLockKey,
} from './turn-silence-notice.js';
import { completeConnectorOffersForConnector } from './connector-offer-completion.js';
import { notifyConnectorHelper } from './postgres-live.js';

type Input<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['input'];
type Output<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['output'];
const id = () => randomBytes(32).toString('hex');
export const INBOX_REPLAY_REWIND_MS = 5_000;

/** A durable silence line stays in the transcript; a later answer does not rewrite it. */
async function settleTurnFailureLine(
  _database: SqlDatabase,
  _roomId: string,
  _requestId: string,
  _agentId: string,
) {
  return;
}
/**
 * Corner operations that stay with the opener. Membership authorizes every
 * other corner write (`DaemonService.assertCornerOpener` says why).
 */
const CORNER_OPENER_ONLY_OPERATIONS = new Set<keyof DaemonOperationMap>(['archiveCorner']);
function isCornerOpenerOnly(name: keyof DaemonOperationMap): boolean {
  return CORNER_OPENER_ONLY_OPERATIONS.has(name);
}
const seconds = (date: Date) => Math.floor(date.getTime() / 1_000);
export { CORNER_WAKE_TIMEOUT_MS } from './corner-wake.js';

/**
 * An expired attachment is named, not hidden: the agent is told the bytes are
 * gone so it says so, instead of reporting a download that "failed".
 */
function markExpiredAttachments(
  attachments: readonly DaemonAttachment[],
  expired: ReadonlySet<string>,
): DaemonAttachment[] {
  if (!expired.size) return [...attachments];
  return attachments.map((attachment) => {
    const id = mediaIdFromUrl(attachment.url);
    return id && expired.has(id) ? { ...attachment, expired: true } : attachment;
  });
}

const MEDIA_URL_PATTERN = /\/v1\/media\/([0-9a-f-]{36})$/;
const DEFAULT_MEDIA_MAXIMUM_BYTES = 25 * 1024 * 1024;

export class DaemonService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly live: LiveHub,
    private readonly roomGitHubToken?: (
      roomId: string,
    ) => Promise<{ token: string; expiresAt: number }>,
    private readonly mediaMaximumBytes: number = DEFAULT_MEDIA_MAXIMUM_BYTES,
    private readonly commandTransaction = false,
    private readonly authorizedCommand?: CommandRow,
    private readonly livePaintDiagnostics = false,
    private readonly liveDiagnosticServerInstance?: string,
    private readonly prChecksStatus?: (
      input: Input<'getPrChecksStatus'>,
    ) => Promise<Output<'getPrChecksStatus'>>,
    private readonly googleOAuth?: import('./google-oauth.js').GoogleOAuth,
  ) {}

  /** When each corner last woke, so `CORNER_WAKE_MIN_INTERVAL_MS` can be held. */
  private readonly lastCornerWake = new Map<string, number>();

  async execute<Name extends keyof DaemonOperationMap>(
    name: Name,
    input: Input<Name>,
    authenticatedAgentId: string,
  ): Promise<Output<Name>> {
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.agentId === 'string' && candidate.agentId !== authenticatedAgentId)
      throw new Error('daemon token does not own requested agent');
    const scopedRoom =
      typeof candidate.roomId === 'string'
        ? candidate.roomId
        : typeof candidate.cornerId === 'string'
          ? candidate.cornerId
          : undefined;
    let cornerReviewer = false;
    let isCorner = false;
    if (scopedRoom && name !== 'ensureAgentMembership' && !this.commandTransaction)
      ({ cornerReviewer, isCorner } = await this.access(scopedRoom, authenticatedAgentId));
    if (scopedRoom && isCornerOpenerOnly(name))
      await this.assertCornerOpener(scopedRoom, authenticatedAgentId);
    const turnWrites = new Set([
      'postRoomMessage',
      'postAgentAttachment',
      'postAgentDraft',
      'postAgentThought',
      'retractAgentLiveOutput',
      'postAgentTurnReceipt',
      'postAgentActivity',
      'createCorner',
      'postRoomEvent',
      'requestAgentGrant',
      'authorizeSquireCall',
      'offerConnector',
      'askRoomChoice',
      'openRoomPoll',
      'putCornerApp',
      'requestCornerAppOpen',
    ]);
    if (
      !this.commandTransaction &&
      scopedRoom &&
      name === 'postRoomMessage' &&
      candidate.relay === undefined &&
      typedMentionHandles(String(candidate.text ?? '')).size === 0 &&
      typeof candidate.replyToMessageId !== 'string' &&
      // A reply naming nobody normally has nothing to route, which is the whole
      // reason for this shorter write: one autocommit statement that commits
      // and publishes on its own. A corner reviewer's reply is the exception —
      // it hands the branch back — and that handoff must not be a second write
      // AFTER the commit. Losing it there is permanent: the verdict is durable,
      // its command output authority is spent, and no retry can re-create the
      // turn, which is exactly the stall this handback exists to remove. So the
      // reviewer takes the transactional path below, where the verdict and the
      // handoff commit together or not at all.
      !cornerReviewer &&
      // A corner question's final reply must create its linked Room report in
      // the same transaction that completes the corner command.
      !(
        isCorner &&
        (await this.isCornerQuestionReply(scopedRoom, authenticatedAgentId, candidate.requestId))
      )
    ) {
      const output = await this.postRoomMessage(
        input as Input<'postRoomMessage'>,
        authenticatedAgentId,
        true,
      );
      if (
        typeof candidate.text === 'string' &&
        /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?\s*$/.test(candidate.text)
      )
        await this.reconcileZeroCheckWorkerCompletion(scopedRoom!, authenticatedAgentId, output.id);
      return output as Output<Name>;
    }
    if (!this.commandTransaction && scopedRoom && turnWrites.has(name)) {
      const writeStartedAt = Date.now();
      const events: LiveEvent[] = [];
      const buffered = new LiveHub();
      buffered.publish = (event) => {
        events.push(event);
      };
      const output = await this.database.transaction(async (db) => {
        const requestId = candidate.requestId ?? candidate.turnId;
        if (name === 'postAgentTurnReceipt' && candidate.status === 'failed') {
          await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
            turnSilenceLockKey(scopedRoom, String(requestId), authenticatedAgentId),
          ]);
        }
        if (
          name === 'postAgentTurnReceipt' &&
          candidate.status === 'working' &&
          !candidate.heartbeat
        ) {
          // Old helpers claim the projected command through their first receipt.
          const pending = (
            await db.query<{ id: string }>(
              `SELECT id FROM agent_commands
            WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND action IN ('input','resume')
            AND state IN ('pending','claimed') ORDER BY created_at DESC LIMIT 1`,
              [scopedRoom, authenticatedAgentId, requestId],
            )
          ).rows[0];
          if (pending)
            await claimAgentCommand(
              db,
              scopedRoom,
              authenticatedAgentId,
              pending.id,
              String(candidate.generationId ?? ''),
            );
        }
        const allowCompleted =
          (name === 'postRoomMessage' && candidate.relay === undefined) ||
          name === 'retractAgentLiveOutput' ||
          (name === 'postAgentTurnReceipt' && candidate.status === 'complete');
        const command =
          name === 'postAgentTurnReceipt' && candidate.status === 'failed'
            ? await authorizeFailedTurnOutput(
                db,
                scopedRoom,
                authenticatedAgentId,
                requestId,
                candidate.generationId,
              )
            : await authorizeCommandOutput(
                db,
                scopedRoom,
                authenticatedAgentId,
                requestId,
                candidate.generationId,
                allowCompleted,
              );
        if (command.state === 'complete') {
          if (name === 'postRoomMessage' && command.result_message_id) {
            const saved = (
              await db.query<{ id: string; created_at: Date; text: string }>(
                `SELECT id,created_at,text FROM messages WHERE id=$1`,
                [command.result_message_id],
              )
            ).rows[0]!;
            if (saved.text !== candidate.text) throw new Error('command result conflict');
            return {
              id: saved.id,
              createdAt: seconds(saved.created_at),
            } as Output<Name>;
          }
          if (name !== 'retractAgentLiveOutput' && name !== 'postAgentTurnReceipt')
            throw new Error('command already completed');
          return this.writeResult() as Output<Name>;
        }
        const scoped = new DaemonService(
          db,
          buffered,
          this.roomGitHubToken,
          this.mediaMaximumBytes,
          true,
          command,
          this.livePaintDiagnostics,
          this.liveDiagnosticServerInstance,
          this.prChecksStatus,
          this.googleOAuth,
        );
        const result = await scoped.execute(name, input, authenticatedAgentId);
        if (name === 'requestAgentGrant') {
          await db.query(
            `UPDATE agent_grants SET command_id=$2 WHERE id=$1 AND command_id IS NULL`,
            [(result as { grantId: string }).grantId, command.id],
          );
        }
        if (
          name === 'authorizeSquireCall' &&
          (result as { status?: string }).status === 'pending' &&
          (result as { grantId?: string }).grantId
        ) {
          await db.query(
            `UPDATE agent_grants SET command_id=$2 WHERE id=$1 AND command_id IS NULL`,
            [(result as { grantId: string }).grantId, command.id],
          );
        }
        if (name === 'offerConnector') {
          // The accept's hidden `connector-offer-decided` line resumes THIS
          // command's turn, the way a grant decision resumes its ask.
          await db.query(
            `UPDATE connector_offers SET command_id=$2 WHERE id::text=$1 AND command_id IS NULL`,
            [(result as { offerId: string }).offerId, command.id],
          );
        }
        if (name === 'postRoomMessage' && candidate.relay === undefined) {
          // routeAgentResult reads the reply's own text for the agents it hands
          // work to, so there is nothing to pre-check here.
          const message = result as unknown as { id: string };
          await routeAgentResult(db, command, message.id);
          await scoped.postCornerQuestionReport(command, message.id, authenticatedAgentId);
          // Every reviewer verdict lands here, tagged or not. `db` is the
          // transaction that inserts the reply and completes its command, so a
          // handoff that throws takes the verdict down with it and the retry
          // writes both — rather than leaving a durable verdict nobody was
          // woken for, which no retry could repair.
          if (cornerReviewer)
            await queueCornerWorkerAfterReview(db, {
              roomId: scopedRoom,
              reviewerAgentId: authenticatedAgentId,
              turnRequestId: command.turn_request_id,
              verdictMessageId: message.id,
            });
        } else if (name === 'postAgentTurnReceipt') {
          if (candidate.status === 'working')
            await db.query(
              `UPDATE agent_commands SET lease_expires_at=now()+interval '90 seconds' WHERE id=$1`,
              [command.id],
            );
          else if (
            candidate.status === 'failed' &&
            (result as { hiccupRestart?: boolean }).hiccupRestart
          ) {
            // noteFirstSilence already reopened this command for re-delivery.
          } else if (
            candidate.status === 'failed' &&
            command.state === 'pending' &&
            !shouldCompletePendingFailedCommand(
              classifyTurnSilence(
                typeof candidate.reason === 'string' ? candidate.reason : undefined,
                typeof candidate.reasonKind === 'string' ? candidate.reasonKind : undefined,
              ).kind,
              typeof candidate.reason === 'string' ? candidate.reason : '',
            )
          ) {
            // Transient corner-start clone/network: the helper retries startCorner.
            // Leave the original pending command for that attempt; do not ask
            // systemd to restart, and do not consume the request.
          } else
            await db.query(`UPDATE agent_commands SET state=$2,completed_at=now() WHERE id=$1`, [
              command.id,
              candidate.status === 'cancelled' ? 'cancelled' : 'complete',
            ]);
        }
        return result;
      });
      for (const event of events) {
        if (event.type !== 'invalidate' || !event.committedRow) {
          this.live.publish(event);
          continue;
        }
        const emittedAt = Date.now();
        this.live.publish({
          ...event,
          trace: {
            id: randomBytes(16).toString('hex'),
            databaseAt: event.committedRow.row.created_at.getTime(),
            emittedAt,
            startedAt: event.committedRow.startedAt ?? writeStartedAt,
          },
        });
      }
      if (
        name === 'postRoomMessage' &&
        candidate.relay === undefined &&
        typeof candidate.text === 'string' &&
        /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?\s*$/.test(candidate.text)
      ) {
        await this.reconcileZeroCheckWorkerCompletion(
          scopedRoom!,
          authenticatedAgentId,
          (output as { id: string }).id,
        );
      }
      return output;
    }
    switch (name) {
      case 'getAgentCommands':
        return (await readAgentCommands(
          this.database,
          scopedRoom!,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'claimAgentCommand':
        await claimAgentCommand(
          this.database,
          scopedRoom!,
          authenticatedAgentId,
          String(candidate.commandId),
          typeof candidate.generationId === 'string' ? candidate.generationId : '',
        );
        this.live.publish({
          type: 'invalidate',
          roomId: scopedRoom!,
          reason: 'turn',
          agentId: authenticatedAgentId,
        });
        return this.writeResult() as Output<Name>;
      case 'acknowledgeAgentCommand': {
        const acknowledged = await this.database.query(
          `UPDATE agent_commands SET state='complete',completed_at=now()
          WHERE id=$1 AND room_id=$2 AND agent_id=$3 AND generation_id=$4 AND (state='complete' OR (state='claimed' AND lease_expires_at>now()))
          AND action='stop'`,
          [candidate.commandId, scopedRoom, authenticatedAgentId, candidate.generationId],
        );
        if (!acknowledged.rowCount) throw new Error('command acknowledgement conflict');
        return this.writeResult() as Output<Name>;
      }
      case 'getDaemonBootstrap':
        return (await this.bootstrap(authenticatedAgentId)) as Output<Name>;
      case 'getWorkspaceRoster':
        return (await this.workspaceRoster(
          input as Input<'getWorkspaceRoster'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getRoomInbox':
      case 'getRoomConversation':
      case 'getCornerCloseRequests':
        return (await this.inbox(
          name,
          input as Input<'getRoomConversation'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getCornerAsk':
        return (await this.getCornerAsk(
          input as Input<'getCornerAsk'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'waitForCornerWake':
        return (await this.waitForCornerWake(
          (input as Input<'waitForCornerWake'>).cornerId,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getRoomAuthority':
        return (await this.roomAuthority(
          input as Input<'getRoomAuthority'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getPermissionAuthority':
        return (await this.permissionAuthority(
          input as Input<'getPermissionAuthority'>,
        )) as Output<Name>;
      case 'getMissionAuthority':
        return (await this.missionAuthority(input as Input<'getMissionAuthority'>)) as Output<Name>;
      case 'listWorkSchedules':
      case 'listAgentToolSchedules':
        return (await this.schedules(
          input as Input<'listAgentToolSchedules'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getWorkScheduleAuthority':
        return (await this.scheduleAuthority(
          input as Input<'getWorkScheduleAuthority'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'createAgentSchedule':
        return (await this.createAgentSchedule(
          input as Input<'createAgentSchedule'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'setEventSubscriptions':
        return (await this.setEventSubscriptions(
          input as Input<'setEventSubscriptions'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'listEventSubscriptions':
        return (await this.listEventSubscriptions(
          input as Input<'listEventSubscriptions'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postRoomEvent':
        return (await this.postRoomEvent(
          input as Input<'postRoomEvent'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'listAgentSchedules':
        return (await this.listAgentSchedules(
          input as Input<'listAgentSchedules'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'deleteAgentSchedule':
        return (await this.deleteAgentSchedule(
          input as Input<'deleteAgentSchedule'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getAgentToolMandate':
        return (await this.mandate(
          input as Input<'getAgentToolMandate'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getTargetAgentAuthority':
        return (await this.targetAuthority(
          input as Input<'getTargetAgentAuthority'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'listRoomCorners':
      case 'listUntrackedCorners':
        return (await this.corners(
          (input as Input<'listRoomCorners'>).roomId,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getPrChecksStatus':
        if (!this.prChecksStatus) throw new Error('GitHub PR checks service unavailable');
        return (await this.prChecksStatus(input as Input<'getPrChecksStatus'>)) as Output<Name>;
      case 'approveCornerMerge':
        return (await this.approveCornerMerge(
          input as Input<'approveCornerMerge'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getCornerRestoreState':
        return (await this.cornerRestore(
          (input as Input<'getCornerRestoreState'>).cornerId,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getRoomRepositoryState':
        return (await this.repository(
          (input as Input<'getRoomRepositoryState'>).roomId,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getRoomGitHubToken': {
        if (!this.roomGitHubToken) throw new Error('GitHub room token service unavailable');
        return (await this.roomGitHubToken(
          (input as Input<'getRoomGitHubToken'>).roomId,
        )) as Output<Name>;
      }
      case 'getRoomTargetBranch':
        return (await this.targetBranch(
          (input as Input<'getRoomTargetBranch'>).roomId,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getIdentitySuccession':
        return (await this.identitySuccession(
          (input as Input<'getIdentitySuccession'>).identityId,
        )) as Output<Name>;
      case 'getAgentConfiguration':
        return (await this.configuration(
          authenticatedAgentId,
          (input as Input<'getAgentConfiguration'>).roomId,
        )) as Output<Name>;
      case 'getAgentPresence':
        return (await this.presence(
          input as Input<'getAgentPresence'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getRequestCompletion':
        return (await this.completion(
          input as Input<'getRequestCompletion'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postRoomMessage':
        return (await this.postRoomMessage(
          input as Input<'postRoomMessage'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'reactToRoomMessage':
        return (await this.reactToRoomMessage(
          input as Input<'reactToRoomMessage'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentAttachment':
        return (await this.postAgentAttachment(
          input as Input<'postAgentAttachment'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentDraft':
        return (await this.liveOutput(
          'draft',
          input as Input<'postAgentDraft'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentThought':
        return (await this.liveOutput(
          'thought',
          input as Input<'postAgentThought'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'retractAgentLiveOutput':
        return (await this.retract(
          input as Input<'retractAgentLiveOutput'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentTurnReceipt':
        return (await this.turnReceipt(
          input as Input<'postAgentTurnReceipt'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentActivity':
        return (await this.activity(
          input as Input<'postAgentActivity'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postPermissionRequest':
        return (await this.permissionRequest(
          input as Input<'postPermissionRequest'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postPermissionExecution':
        return (await this.permissionExecution(
          input as Input<'postPermissionExecution'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postWorkSchedule':
        return (await this.postSchedule(
          input as Input<'postWorkSchedule'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postWorkScheduleReceipt':
        return (await this.scheduleReceipt(
          input as Input<'postWorkScheduleReceipt'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentToolScheduleIndex':
        return (await this.scheduleIndex(
          input as Input<'postAgentToolScheduleIndex'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentToolMandate':
        return (await this.postMandate(
          input as Input<'postAgentToolMandate'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentCommands':
        return (await this.commands(
          input as Input<'postAgentCommands'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentModelCatalog':
        return (await this.modelCatalog(
          input as Input<'postAgentModelCatalog'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postAgentMachineReport':
        return (await this.machineReport(
          input as Input<'postAgentMachineReport'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getConnectorAssignments':
        return (await this.connectorAssignments(authenticatedAgentId)) as Output<Name>;
      case 'getGoogleOAuthGrant': {
        const credentials = await this.googleOAuth?.grantForHelper(
          (input as Input<'getGoogleOAuthGrant'>).connectorId,
          authenticatedAgentId,
        );
        return (
          credentials ? { status: 'ready', credentials } : { status: 'pending' }
        ) as Output<Name>;
      }
      case 'installConnector':
        return (await this.connectorInstall(
          input as Input<'installConnector'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postConnectorStatus':
        return (await this.connectorStatusReport(
          input as Input<'postConnectorStatus'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postConnectorVault':
        return (await this.connectorVaultReport(
          input as Input<'postConnectorVault'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getConnectorStatus':
        return (await this.connectorStatusView(
          authenticatedAgentId,
          (input as Input<'getConnectorStatus'>).connectorId,
        )) as Output<Name>;
      case 'getConnectorVaultList':
        return (await this.connectorVaultList(authenticatedAgentId)) as Output<Name>;
      case 'getConnectionDetail':
        return (await this.connectionDetail(
          input as Input<'getConnectionDetail'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'revokeConnectionGrants':
        return (await this.connectionGrantRevoke(
          input as Input<'revokeConnectionGrants'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postConnectionUsage':
        return (await this.connectionUsage(
          input as Input<'postConnectionUsage'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postCornerLifecycle':
        return (await this.cornerLifecycle(
          input as Input<'postCornerLifecycle'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postCornerRemoteState':
        return (await this.cornerRemote(
          input as Input<'postCornerRemoteState'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postCornerPlan':
        return (await this.cornerPlan(
          input as Input<'postCornerPlan'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'putCornerApp':
        return (await this.putCornerApp(
          input as Input<'putCornerApp'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'requestCornerAppOpen':
        return (await this.requestCornerAppOpen(
          input as Input<'requestCornerAppOpen'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'postTargetBranchProposal':
        return (await this.targetProposal(
          input as Input<'postTargetBranchProposal'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'requestAgentGrant':
        return (await this.requestAgentGrant(
          input as Input<'requestAgentGrant'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'askRoomChoice':
        return (await this.askRoomChoice(
          input as Input<'askRoomChoice'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'openRoomPoll':
        return (await this.openRoomPoll(
          input as Input<'openRoomPoll'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'listAgentGrants':
        return (await this.listAgentGrants(
          authenticatedAgentId,
          (input as Input<'listAgentGrants'>).roomId,
        )) as Output<Name>;
      case 'consumeAgentGrant':
        return (await this.consumeAgentGrant(
          input as Input<'consumeAgentGrant'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'authorizeSquireCall':
        return (await this.authorizeSquireCall(
          input as Input<'authorizeSquireCall'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'readAgentWorkbench':
        return (await this.agentWorkbench(
          input as Input<'readAgentWorkbench'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'offerConnector':
        return (await this.offerConnector(
          input as Input<'offerConnector'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'createCorner':
        return (await this.createCorner(
          input as Input<'createCorner'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'archiveCorner':
        return (await this.archiveCorner(
          (input as Input<'archiveCorner'>).cornerId,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'ensureAgentMembership':
        return (await this.ensureMembership(
          input as Input<'ensureAgentMembership'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getWalletToolState':
        return (await agentWalletTool(
          this.database,
          'state',
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getWalletToolBalance':
        return (await agentWalletTool(
          this.database,
          'balance',
          authenticatedAgentId,
          input as Input<'getWalletToolBalance'>,
        )) as Output<Name>;
      case 'getWalletToolChains':
        return (await agentWalletTool(
          this.database,
          'chains',
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getWalletToolHistory':
        return (await agentWalletTool(
          this.database,
          'history',
          authenticatedAgentId,
          input as Input<'getWalletToolHistory'>,
        )) as Output<Name>;
      case 'getWalletToolQuote':
        return (await agentWalletTool(
          this.database,
          'quote',
          authenticatedAgentId,
          input as Input<'getWalletToolQuote'>,
        )) as Output<Name>;
      case 'walletPay':
        return (await agentWalletTool(
          this.database,
          'pay',
          authenticatedAgentId,
          input as Input<'walletPay'>,
        )) as Output<Name>;
      case 'walletSwap':
        return (await agentWalletTool(
          this.database,
          'swap',
          authenticatedAgentId,
          input as Input<'walletSwap'>,
        )) as Output<Name>;
      default:
        throw new Error(`unsupported daemon operation: ${String(name)}`);
    }
  }

  /**
   * A repository with no checks emits no check webhook, so its configured
   * reviewer otherwise waits forever. Resolve that absence only after the
   * worker has finished its PR turn; at PR-open time the same empty rollup is
   * merely a race with GitHub registering workflows.
   */
  private async reconcileZeroCheckWorkerCompletion(
    cornerId: string,
    workerAgentId: string,
    sourceMessageId: string,
  ): Promise<void> {
    if (!this.prChecksStatus) return;
    const candidate = (
      await this.database.query<{
        reviewer_agent_id: string;
        owner_agent_id: string;
      }>(
        `SELECT parent.reviewer_agent_id,fact.owner_agent_id
         FROM rooms corner
         JOIN rooms parent ON parent.id=corner.parent_id
         JOIN corner_facts fact ON fact.corner_id=corner.id
         WHERE corner.id=$1 AND parent.reviewer_agent_id IS NOT NULL
           AND parent.reviewer_agent_id<>$2 AND fact.owner_agent_id=$2
           AND fact.lifecycle ? 'pr'`,
        [cornerId, workerAgentId],
      )
    ).rows[0];
    // Preserve the established no-reviewer path exactly: it does not pay for a
    // GitHub read and does not receive a synthetic completion turn.
    if (!candidate) return;

    let verdict: Output<'getPrChecksStatus'>;
    try {
      verdict = await this.prChecksStatus({ cornerId });
    } catch (error) {
      console.error(`[server] zero-check completion read failed for corner ${cornerId}:`, error);
      return;
    }
    if (verdict.checks !== 'pending' || verdict.checkCount !== 0) return;

    await this.database.transaction(async (db) => {
      const current = (
        await db.query<{
          reviewer_agent_id: string | null;
          owner_agent_id: string;
          lifecycle: import('@beeline/api-contract/phone').CornerLifecycleView;
        }>(
          `SELECT parent.reviewer_agent_id,fact.owner_agent_id,fact.lifecycle
           FROM rooms corner
           JOIN rooms parent ON parent.id=corner.parent_id
           JOIN corner_facts fact ON fact.corner_id=corner.id
           WHERE corner.id=$1 FOR UPDATE OF fact`,
          [cornerId],
        )
      ).rows[0];
      if (
        !current ||
        current.owner_agent_id !== workerAgentId ||
        current.reviewer_agent_id !== candidate.reviewer_agent_id ||
        current.lifecycle.pr?.headSha !== verdict.headSha ||
        current.lifecycle.checks === 'passing'
      )
        return;
      const lifecycle = {
        ...current.lifecycle,
        checks: 'passing' as const,
        checksSummary: {
          status: 'passing' as const,
          total: 0,
          failing: [],
          checks: [],
          updatedAt: Math.floor(Date.now() / 1_000),
        },
      };
      await db.query(
        `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL,updated_at=now()
         WHERE corner_id=$1`,
        [cornerId, JSON.stringify(lifecycle)],
      );
      await routeSystemCommand(db, {
        roomId: cornerId,
        sourceMessageId,
        kind: 'check-passed',
        targets: [],
      });
    });
  }

  // --- Workbench: connector helper operations --------------------------------

  /**
   * The helper's work queue for connectors it serves. Install/uninstall are
   * derived from the connector's own status (idempotent across polls); sync
   * is an edge-triggered token the read clears. Revoke-grants stays queued
   * until the helper confirms the provider drop.
   */
  private async connectorAssignments(agentId: string): Promise<Output<'getConnectorAssignments'>> {
    const connectors = (
      await this.database.query<{
        id: string;
        connector_type: string;
        status: string;
        pending_ops: string[];
        pairing_generation: number;
      }>(
        `SELECT id,connector_type,status,pending_ops,pairing_generation FROM workspace_connectors
         WHERE helper_agent_id=$1 AND status IN ('installing','connected','error','disconnected')
         ORDER BY created_at`,
        [agentId],
      )
    ).rows;
    const assignments: ConnectorAssignment[] = [];
    for (const row of connectors) {
      const adapter = connectorAdapter(row.connector_type);
      const generation = { pairingGeneration: row.pairing_generation };
      if (adapter) {
        for (const kind of adapter.assignmentKinds(
          row.status as 'disconnected' | 'installing' | 'connected' | 'error',
        )) {
          if (kind !== 'install' && kind !== 'uninstall' && kind !== 'refresh-google-grant')
            continue;
          assignments.push(
            kind === 'refresh-google-grant'
              ? {
                  kind,
                  connectorId: row.id,
                  connectorType: row.connector_type as never,
                }
              : {
                  kind,
                  connectorId: row.id,
                  connectorType: row.connector_type as never,
                  ...generation,
                },
          );
        }
      } else {
        if (row.status === 'installing')
          assignments.push({
            kind: 'install',
            connectorId: row.id,
            connectorType: row.connector_type as never,
            ...generation,
          });
        if (row.status === 'disconnected')
          assignments.push({
            kind: 'uninstall',
            connectorId: row.id,
            connectorType: row.connector_type as never,
            ...generation,
          });
      }
      for (const op of row.pending_ops ?? []) {
        if (op === 'sync')
          assignments.push({
            kind: 'sync',
            connectorId: row.id,
            connectorType: row.connector_type as never,
          });
        else if (op.startsWith('revoke-grants:'))
          assignments.push({
            kind: 'revoke-grants',
            connectorId: row.id,
            connectorType: row.connector_type as never,
            reference: op.slice('revoke-grants:'.length),
          });
      }
    }
    const pendingIds = connectors
      .filter((row) => (row.pending_ops ?? []).length > 0)
      .map((row) => row.id);
    if (pendingIds.length)
      await this.database.query(
        `UPDATE workspace_connectors SET pending_ops = COALESCE((
           SELECT jsonb_agg(to_jsonb(elem))
           FROM jsonb_array_elements_text(pending_ops) AS elem
           WHERE elem LIKE 'revoke-grants:%'
         ), '[]'::jsonb)
         WHERE id = ANY($1::uuid[])`,
        [pendingIds],
      );
    return { assignments };
  }

  /**
   * The helper reports it completed (or accepted) an install. `sign_in` is
   * written, not merged: the run that reaches `connected` printed no
   * ceremony, so whatever tunnel an earlier run published dies with it.
   */
  private async connectorInstall(
    input: Input<'installConnector'>,
    agentId: string,
  ): Promise<Output<'installConnector'>> {
    const result = await this.database.transaction(async (database) => {
      const row = (
        await database.query<{ id: string; pairing_generation: number }>(
          `SELECT id,pairing_generation FROM workspace_connectors
            WHERE id=$1::uuid AND helper_agent_id=$2 AND status='installing' FOR UPDATE`,
          [input.connectorId, agentId],
        )
      ).rows[0];
      if (!row) throw new Error('connector not found for this helper');
      if (
        input.pairingGeneration !== undefined &&
        input.pairingGeneration !== row.pairing_generation
      )
        throw new Error('connector not found for this helper');
      await database.query(
        `UPDATE workspace_connectors
         SET status='connected', status_steps='[]'::jsonb, status_error=NULL,
             squire_version=COALESCE($2,squire_version),
             signed_in_as=COALESCE($3,signed_in_as),
             sign_in=$4::jsonb,
             connected_at=COALESCE(connected_at, now()), updated_at=now()
         WHERE id=$1::uuid`,
        [
          row.id,
          input.squireVersion ?? null,
          input.signedInAs ?? null,
          input.signIn ? JSON.stringify(input.signIn) : null,
        ],
      );
      return {
        row,
        completedOffers: await completeConnectorOffersForConnector(database, row.id),
      };
    });
    for (const offer of result.completedOffers) {
      this.live.publish({
        type: 'invalidate',
        roomId: offer.roomId,
        reason: 'connector-offer',
        agentId: offer.agentId,
      });
    }
    return { id: result.row.id, createdAt: Math.floor(Date.now() / 1000) };
  }

  /**
   * One incremental install report from the helper: the ordered steps as they
   * settle, plus the sign-in surface and installed version it learned. A
   * report carrying `errorMessage` marks the run failed; otherwise the row
   * stays installing until `installConnector` completes it.
   *
   * Status, helper, and pairing generation are revalidated in the UPDATE so a
   * disconnect or re-pair that lands between a stale helper's read and write
   * cannot overwrite the newer lifecycle. An omitted generation is generation
   * 1: a pre-generation helper can still report against the first pairing and
   * cannot match a later one.
   */
  private async connectorStatusReport(
    input: Input<'postConnectorStatus'>,
    agentId: string,
  ): Promise<Output<'postConnectorStatus'>> {
    const row = (
      await this.database.query<{ id: string }>(
        `UPDATE workspace_connectors
         SET status=CASE WHEN $3::text IS NOT NULL THEN 'error' ELSE status END,
             status_error=COALESCE($3::text,status_error),
             status_steps=$2::jsonb,
             squire_version=COALESCE($4,squire_version),
             signed_in_as=COALESCE($5,signed_in_as),
             sign_in=CASE WHEN $7::boolean THEN $6::jsonb ELSE sign_in END,
             updated_at=now()
         WHERE id=$1::uuid
           AND helper_agent_id=$8
           AND status='installing'
           AND pairing_generation=$9
         RETURNING id`,
        [
          input.connectorId,
          JSON.stringify(input.steps),
          input.errorMessage ?? null,
          input.squireVersion ?? null,
          input.signedInAs ?? null,
          input.signIn ? JSON.stringify(input.signIn) : null,
          input.signIn !== undefined,
          agentId,
          input.pairingGeneration ?? 1,
        ],
      )
    ).rows[0];
    if (!row) throw new Error('connector not found for this helper');
    return { id: row.id, createdAt: Math.floor(Date.now() / 1000) };
  }

  /**
   * One helper vault report (metadata only): upserted into the sovereign
   * connection rows of every live trusty-squire connector this helper serves
   * whose owner is this helper's owner. One helper carries ONE Squire account;
   * a foreign Workbench row on the same helper does not inherit that vault.
   */
  private async connectorVaultReport(
    input: Input<'postConnectorVault'>,
    agentId: string,
  ): Promise<Output<'postConnectorVault'>> {
    const connectors = (
      await this.database.query<{ id: string; owner_identity_id: string }>(
        `SELECT c.id,c.owner_identity_id FROM workspace_connectors c
         JOIN agents a ON a.agent_id=c.helper_agent_id
         WHERE c.helper_agent_id=$1 AND c.connector_type='trusty-squire' AND c.status='connected'
           AND c.owner_identity_id=a.owner_id`,
        [agentId],
      )
    ).rows;
    for (const connector of connectors)
      await applyVaultList(this.database, connector, input.connections);
    return { id: agentId, createdAt: Math.floor(Date.now() / 1000) };
  }

  /**
   * The helper polls one connector's state; stale metadata stages a sync.
   * `connectorId` names WHICH row — a helper carrying the four Google rows
   * beside its Squire row would otherwise read whichever came first.
   */
  private async connectorStatusView(
    agentId: string,
    connectorId?: string,
  ): Promise<Output<'getConnectorStatus'>> {
    const rows = (
      await this.database.query<{
        id: string;
        status: string;
        status_steps: ConnectorStep[] | null;
        status_error: string | null;
      }>(
        `SELECT id,status,status_steps,status_error FROM workspace_connectors
         WHERE helper_agent_id=$1
         ORDER BY created_at`,
        [agentId],
      )
    ).rows;
    // Reap unpaired rows the uninstall assignment has had time to reach: the
    // helper's status poll after the drain is the uninstall ack path.
    for (const row of rows) {
      if (row.status !== 'disconnected') continue;
      const empty = await this.database.query(
        `SELECT 1 FROM workspace_connections WHERE connector_id=$1::uuid LIMIT 1`,
        [row.id],
      );
      if (!empty.rowCount)
        await this.database.query(`DELETE FROM workspace_connectors WHERE id=$1::uuid`, [row.id]);
    }
    const live = (
      await this.database.query<{
        id: string;
        status: string;
        status_steps: ConnectorStep[] | null;
        status_error: string | null;
        sign_in: ConnectorStatus['signIn'] | null;
      }>(
        `SELECT id,status,status_steps,status_error,sign_in FROM workspace_connectors
         WHERE helper_agent_id=$1 AND status IN ('installing','connected','error')
           AND ($2::uuid IS NULL OR id=$2::uuid)
         ORDER BY created_at LIMIT 1`,
        [agentId, connectorId ?? null],
      )
    ).rows[0];
    if (!live) return { connectorId: '', status: 'disconnected', steps: [] };
    return {
      connectorId: live.id,
      status: live.status as ConnectorStatus['status'],
      steps: live.status_steps ?? [],
      ...(live.sign_in ? { signIn: live.sign_in } : {}),
      ...(live.status_error ? { errorMessage: live.status_error } : {}),
    };
  }

  /** The cached vault metadata for the helper's connections; stale rows stage a sync. */
  private async connectorVaultList(agentId: string): Promise<Output<'getConnectorVaultList'>> {
    const rows = (
      await this.database.query<{
        id: string;
        connector_id: string;
        reference: string;
        service: string | null;
        label: string | null;
        hosts: string[];
        state: string;
        connection_metadata: { fieldNames?: string[]; vaultCreatedAt?: number } | null;
        last_synced_at: Date | null;
      }>(
        `SELECT c.id,c.connector_id,c.reference,c.service,c.label,c.hosts,c.state,
                c.connection_metadata,c.last_synced_at
         FROM workspace_connections c
         JOIN workspace_connectors k ON k.id=c.connector_id
         WHERE k.helper_agent_id=$1
         ORDER BY c.created_at`,
        [agentId],
      )
    ).rows;
    const staleConnectorIds = new Set<string>();
    const connections = rows.map((row) => {
      if (isMetadataStale(row.last_synced_at)) staleConnectorIds.add(row.connector_id);
      return {
        reference: row.reference,
        service: row.service,
        label: row.label ?? row.reference,
        fieldNames: row.connection_metadata?.fieldNames ?? [],
        allowedHosts: row.hosts ?? [],
        createdAt: row.connection_metadata?.vaultCreatedAt ?? Math.floor(Date.now() / 1000),
        stale: isMetadataStale(row.last_synced_at),
        state: row.state === 'error' ? ('error' as const) : ('active' as const),
      };
    });
    for (const connectorId of staleConnectorIds) {
      await this.database.query(
        `UPDATE workspace_connectors
         SET pending_ops = pending_ops || '"sync"'::jsonb, updated_at=now()
         WHERE id=$1::uuid AND NOT pending_ops @> '"sync"'::jsonb`,
        [connectorId],
      );
      await notifyConnectorHelper(this.database, connectorId);
    }
    return { connections };
  }

  /** Cached detail for one connection the helper serves. */
  private async connectionDetail(
    input: Input<'getConnectionDetail'>,
    agentId: string,
  ): Promise<Output<'getConnectionDetail'>> {
    const row = (
      await this.database.query<{
        id: string;
        connector_id: string;
        reference: string;
        service: string | null;
        label: string | null;
        hosts: string[];
        state: string;
        grants: Array<Record<string, unknown>> | null;
        connection_metadata: { fieldNames?: string[]; vaultCreatedAt?: number } | null;
        last_synced_at: Date | null;
      }>(
        `SELECT c.id,c.connector_id,c.reference,c.service,c.label,c.hosts,c.state,
                c.grants,c.connection_metadata,c.last_synced_at
         FROM workspace_connections c
         JOIN workspace_connectors k ON k.id=c.connector_id
         WHERE k.helper_agent_id=$1 AND c.reference=$2`,
        [agentId, input.ref],
      )
    ).rows[0];
    if (!row) throw new Error(`unknown connection reference ${input.ref}`);
    if (isMetadataStale(row.last_synced_at)) {
      await this.database.query(
        `UPDATE workspace_connectors
         SET pending_ops = pending_ops || '"sync"'::jsonb, updated_at=now()
         WHERE id=$1::uuid AND NOT pending_ops @> '"sync"'::jsonb`,
        [row.connector_id],
      );
      await notifyConnectorHelper(this.database, row.connector_id);
    }
    const ledger = (
      await this.database.query<{
        id: string;
        operation: string;
        status_code: number | null;
        bytes: string;
        grant_info: string | null;
        created_at: Date;
      }>(
        `SELECT id,operation,status_code,bytes,grant_info,created_at
         FROM connection_receipts WHERE connection_id=$1::uuid
         ORDER BY created_at DESC LIMIT 50`,
        [row.id],
      )
    ).rows;
    return {
      metadata: {
        reference: row.reference,
        service: row.service,
        label: row.label ?? row.reference,
        fieldNames: row.connection_metadata?.fieldNames ?? [],
        allowedHosts: row.hosts ?? [],
        createdAt: row.connection_metadata?.vaultCreatedAt ?? Math.floor(Date.now() / 1000),
        stale: isMetadataStale(row.last_synced_at),
        state: row.state === 'error' ? 'error' : 'active',
      },
      grants: (row.grants ?? []) as unknown as Output<'getConnectionDetail'>['grants'],
      ledger: ledger.map((entry) => ({
        id: entry.id,
        timestamp: Math.floor(entry.created_at.getTime() / 1000),
        action: entry.operation,
        ...(entry.status_code !== null ? { status: entry.status_code } : {}),
        ...(Number(entry.bytes) > 0 ? { bytes: Number(entry.bytes) } : {}),
        ...(entry.grant_info ? { actor: entry.grant_info } : {}),
      })),
    };
  }

  /** Helper confirmation that the provider dropped the grants. */
  private async connectionGrantRevoke(
    input: Input<'revokeConnectionGrants'>,
    agentId: string,
  ): Promise<Output<'revokeConnectionGrants'>> {
    const row = (
      await this.database.query<{
        id: string;
        connector_id: string;
        reference: string;
        grants: Array<Record<string, unknown>> | null;
      }>(
        `SELECT c.id,c.connector_id,c.reference,c.grants
         FROM workspace_connections c
         JOIN workspace_connectors k ON k.id=c.connector_id
         WHERE k.helper_agent_id=$1 AND c.reference=$2`,
        [agentId, input.ref],
      )
    ).rows[0];
    if (!row) throw new Error(`unknown connection reference ${input.ref}`);
    const live = (row.grants ?? []).filter((grant) => !grant.revokedAt);
    const revokedAt = Math.floor(Date.now() / 1000);
    const updated = (row.grants ?? []).map((grant) => {
      if (grant.revokedAt) return grant;
      const next: Record<string, unknown> = { ...grant, revokedAt };
      delete next.revokingAt;
      return next;
    });
    await this.database.query(
      `UPDATE workspace_connections SET grants=$2::jsonb, updated_at=now() WHERE id=$1::uuid`,
      [row.id, JSON.stringify(updated)],
    );
    await this.database.query(
      `UPDATE workspace_connectors SET pending_ops = COALESCE((
         SELECT jsonb_agg(to_jsonb(elem))
         FROM jsonb_array_elements_text(pending_ops) AS elem
         WHERE elem <> $2
       ), '[]'::jsonb), updated_at=now()
       WHERE id=$1::uuid`,
      [row.connector_id, `revoke-grants:${row.reference}`],
    );
    return { revoked: live.length, failed: 0 };
  }

  private async connectionUsage(
    input: Input<'postConnectionUsage'>,
    agentId: string,
  ): Promise<Output<'postConnectionUsage'>> {
    await receiveConnectionUsage(this.database, input, agentId);
    return { id: input.requestId, createdAt: Math.floor(Date.now() / 1000) };
  }

  private async bootstrap(agentId: string) {
    const workspaces = await this.database.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM memberships WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL`,
      [agentId],
    );
    const rooms = await this.database.query<{ room_id: string; archived: boolean }>(
      `SELECT m.room_id, r.archived_at IS NOT NULL archived FROM memberships m
       JOIN rooms r ON r.id=m.room_id
       WHERE m.identity_id=$1 AND m.removed_at IS NULL AND r.parent_id IS NULL`,
      [agentId],
    );
    return {
      workspaceIds: workspaces.rows.map((row) => row.workspace_id),
      rooms: rooms.rows.map((row) => ({ roomId: row.room_id, archived: row.archived })),
    };
  }
  private async workspaceRoster(input: Input<'getWorkspaceRoster'>, agentId: string) {
    const access = await this.database.query(
      `SELECT 1 FROM memberships
       WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
      [input.workspaceId, agentId],
    );
    if (!access.rowCount) throw new Error('workspace membership required');
    const rows = await this.database.query<{
      identity_id: string;
      kind: 'human' | 'agent';
      name: string;
      handle: string | null;
      role: 'owner' | 'admin' | 'member';
      owner_id: string | null;
      soul: {
        name?: string;
        instructions?: string;
        avatarSeed?: string;
        avatar?: string;
      } | null;
      agent_updated_at: Date | null;
    }>(
      `SELECT m.identity_id,
         i.kind,i.name,i.handle,
         m.role,a.owner_id,a.soul,a.updated_at agent_updated_at
       FROM memberships m
       JOIN identities i ON i.id=m.identity_id
       LEFT JOIN agents a ON a.agent_id=i.id
       WHERE m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
         AND i.hidden_from_roster=false
       ORDER BY i.kind,i.name,i.id`,
      [input.workspaceId],
    );
    return {
      members: rows.rows.map((row) => ({
        identityId: row.identity_id,
        kind: row.kind,
        name: row.name,
        ...(row.handle ? { handle: row.handle } : {}),
        role: row.role,
        ...(row.kind === 'agent' &&
        row.soul?.name &&
        typeof row.soul.instructions === 'string' &&
        row.owner_id &&
        row.agent_updated_at
          ? {
              soul: {
                name: row.soul.name,
                instructions: row.soul.instructions,
                avatarSeed: row.soul.avatarSeed ?? row.identity_id,
                ...(row.soul.avatar ? { avatar: row.soul.avatar } : {}),
                authoredBy: row.owner_id,
                updatedAt: seconds(row.agent_updated_at),
              },
            }
          : {}),
      })),
    };
  }
  private async inbox(name: string, input: Input<'getRoomConversation'>, agentId: string) {
    const roomId =
      name === 'getCornerCloseRequests'
        ? (input as unknown as { cornerId: string }).cornerId
        : input.roomId;
    await this.access(roomId, agentId);
    const closeRequested =
      name === 'getCornerCloseRequests'
        ? Boolean(
            (
              await this.database.query<{ close_requested: boolean }>(
                `SELECT close_requested FROM corner_facts WHERE corner_id=$1`,
                [roomId],
              )
            ).rows[0]?.close_requested,
          )
        : undefined;
    if (name === 'getRoomInbox' || name === 'getCornerCloseRequests')
      return {
        ...(await commandInbox(this.database, roomId, agentId)),
        ...(closeRequested !== undefined ? { closeRequested } : {}),
      };
    const commandInboxRead = false;
    if (input.startAtLatest) {
      if (input.after) throw new Error('startAtLatest cannot be combined with after');
      const latest = await this.database.query<{
        id: string;
        created_at: Date;
        cursor_ms: string;
      }>(
        // A caused system line is stamped up to 1s into the future
        // (`systemLine`'s ordering floor), so the newest row's stamp can sit
        // ahead of the clock. A high-water mark must only ever name stamps the
        // clock has reached: a future one swallows every real message written
        // inside that window, and the daemon never sees them — no turn starts.
        `SELECT id,created_at,${MESSAGE_CURSOR_MS_SQL} cursor_ms
         FROM messages WHERE room_id=$1 AND created_at <= now()
         ORDER BY cursor_ms DESC,id DESC LIMIT 1`,
        [roomId],
      );
      const highWater = latest.rows[0];
      // An empty Room still needs an activation position. Without one, a
      // reconnect after its first messages calls startAtLatest again and
      // silently declares those offline messages to be history.
      const activationCursor = highWater
        ? `${highWater.cursor_ms},${highWater.id}`
        : `${
            (
              await this.database.query<{ now_ms: string }>(
                `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint now_ms`,
              )
            ).rows[0]!.now_ms
          },${'f'.repeat(64)}`;
      const rewindIds = highWater
        ? (
            await this.database.query<{ id: string }>(
              `SELECT id FROM messages
               WHERE room_id=$1
                 AND ${MESSAGE_CURSOR_MS_SQL} >= $2::bigint - ${INBOX_REPLAY_REWIND_MS}
                 AND (${MESSAGE_CURSOR_MS_SQL},id) <= ($2::bigint,$3)
               ORDER BY ${MESSAGE_CURSOR_MS_SQL},id`,
              [roomId, highWater.cursor_ms, highWater.id],
            )
          ).rows.map((row) => row.id)
        : [];
      return {
        dispatchVersion: 1 as const,
        items: [],
        cursor: activationCursor,
        rewindIds,
        ...(closeRequested !== undefined ? { closeRequested } : {}),
      };
    }
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    const after = input.after?.match(/^(\d+),([0-9a-f]{64})$/);
    if (input.after && !after) throw new Error('invalid inbox cursor');
    // A conversation read defaults to the NEWEST page: a turn is prompted from
    // the most recent messages, and the first 200 rows of a long Room are old
    // news. Startup objective recovery is the one caller that wants the other
    // end and asks for it by name (`window: 'earliest'`) — the two needs share
    // this code path, so they are selected here rather than by reversing the
    // sort for everyone. `getRoomInbox` and any cursor walk keep the ascending
    // forward semantics untouched.
    const newestPage = name === 'getRoomConversation' && !after && input.window !== 'earliest';
    const continuityPage =
      name === 'getRoomConversation' && !after && input.window === 'continuity';
    const rows = await this.database.query<{
      id: string;
      author_id: string;
      created_at: Date;
      presentation: string;
      text: string;
      corner_ask_id: string | null;
      agent_author: boolean;
      reply_to_message_id: string | null;
      reply_to_author_id: string | null;
      root_message_id: string | null;
      request_id: string | null;
      request_author_id: string | null;
      agent_hop_count: number;
      attachments: DaemonAttachment[];
      cursor_ms: string;
      now_ms: string;
      system_event: SystemEvent | null;
    }>(
      // The newest page takes exactly `limit` rows from the tail and puts them
      // back in transcript order; the forward walk keeps its `limit + 1` probe
      // for whether another page exists.
      continuityPage
        ? `SELECT * FROM (${conversationColumns}
             FROM messages WHERE room_id=$1 AND presentation='message'
             ORDER BY cursor_ms DESC,id DESC LIMIT ${limit}) continuity
           ORDER BY cursor_ms,id`
        : newestPage
          ? `SELECT * FROM (${conversationColumns}
             FROM messages WHERE room_id=$1
             ORDER BY cursor_ms DESC,id DESC LIMIT ${limit}) newest
           ORDER BY cursor_ms,id`
          : `${conversationColumns}
             FROM messages WHERE room_id=$1
               ${
                 after
                   ? input.rewind
                     ? `AND ${MESSAGE_CURSOR_MS_SQL} >= $2::bigint - ${INBOX_REPLAY_REWIND_MS}`
                     : `AND (${MESSAGE_CURSOR_MS_SQL},id) > ($2::bigint,$3)`
                   : ''
               }
             ORDER BY cursor_ms,id LIMIT ${limit + 1}`,
      after ? (input.rewind ? [roomId, after[1]] : [roomId, after[1], after[2]]) : [roomId],
    );
    const page = newestPage ? rows.rows : rows.rows.slice(0, limit);
    const visiblePage = page;
    const expiredMedia = await this.expiredMediaIds(
      visiblePage.flatMap((row) => row.attachments ?? []),
    );
    const savedNarration =
      name === 'getRoomConversation' && input.narrationRequestId
        ? (
            await this.database.query<{ text: string }>(
              `SELECT item->>'text' text FROM messages message,
                      jsonb_array_elements(message.activity) item
               WHERE message.room_id=$1 AND message.author_id=$2
                 AND message.request_id=$3 AND message.presentation='activity'
                 AND item->>'kind'='output' AND item->>'text' IS NOT NULL
               ORDER BY message.created_at,message.id`,
              [roomId, agentId, input.narrationRequestId],
            )
          ).rows.map((row) => row.text)
        : undefined;
    // Same future-stamp rule as the startAtLatest high-water: the returned
    // cursor advances only onto rows the clock has reached. A not-yet-settled
    // line is still DELIVERED (it mentions nobody whose daemon it could
    // double-wake) and simply re-delivers on the next poll, at most until its
    // stamp arrives — ≤1s.
    const cursorRow = [...page].reverse().find((row) => row.cursor_ms <= row.now_ms);
    const cursor = laterCursor(
      cursorRow ? `${cursorRow.cursor_ms},${cursorRow.id}` : undefined,
      input.after,
    );
    return {
      ...(commandInboxRead ? { dispatchVersion: 1 as const } : {}),
      items: visiblePage.map((row) => ({
        id: row.id,
        cursor: `${row.cursor_ms},${row.id}`,
        authorId: row.author_id,
        createdAt: seconds(row.created_at),
        type: row.presentation,
        body: row.text,
        ...(row.corner_ask_id ? { cornerAskId: row.corner_ask_id } : {}),
        ...(row.agent_author ? { agentAuthor: true } : {}),
        ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
        ...(row.reply_to_author_id ? { replyToAuthorId: row.reply_to_author_id } : {}),
        ...(row.root_message_id ? { rootMessageId: row.root_message_id } : {}),
        ...(row.request_id ? { requestId: row.request_id } : {}),
        ...(row.request_author_id ? { requestAuthorId: row.request_author_id } : {}),
        ...(row.agent_hop_count ? { agentHopCount: row.agent_hop_count } : {}),
        attachments: markExpiredAttachments(row.attachments ?? [], expiredMedia),
        ...(row.system_event ? { systemEvent: row.system_event } : {}),
      })),
      ...(cursor ? { cursor } : {}),
      ...(savedNarration ? { savedNarration } : {}),
      ...(closeRequested !== undefined ? { closeRequested } : {}),
    };
  }

  /** Media ids these attachments name whose bytes are past the TTL (`media-ttl.ts`). */
  private async expiredMediaIds(
    attachments: readonly DaemonAttachment[],
  ): Promise<ReadonlySet<string>> {
    const ids = new Set<string>();
    for (const attachment of attachments) {
      const id = mediaIdFromUrl(attachment.url);
      if (id) ids.add(id);
    }
    if (!ids.size) return ids;
    const expired = await this.database.query<{ id: string }>(
      `SELECT id::text id FROM object_expirations WHERE id=ANY($1::uuid[])`,
      [[...ids]],
    );
    return new Set(expired.rows.map((row) => row.id));
  }
  /**
   * Who this principal is in the Room, and — the half a helper cannot decide for
   * itself — whether the agent asking is allowed to answer them.
   *
   * The access policy lives on `agents.access_policy` and is read HERE, on the
   * round trip the intake loop already makes per candidate message. That is what
   * makes an owner's change in the members page effective on a helper that is
   * already running: the next poll asks again and gets the new answer, with no
   * reconnect, no restart, and nothing cached in the runtime record.
   */
  private async roomAuthority(input: Input<'getRoomAuthority'>, agentId: string) {
    const row = (
      await this.database.query<{
        workspace_id: string;
        role: 'owner' | 'admin' | 'member';
        kind: 'human' | 'agent';
        archived: boolean;
        access_policy: unknown;
        owner_id: string | null;
      }>(
        `SELECT r.workspace_id,m.role,i.kind,r.archived_at IS NOT NULL archived,a.access_policy,a.owner_id
         FROM rooms r
         LEFT JOIN memberships m ON m.room_id=r.id AND m.identity_id=$2 AND m.removed_at IS NULL
         LEFT JOIN identities i ON i.id=$2
         LEFT JOIN agents a ON a.agent_id=$3
         WHERE r.id=$1`,
        [input.roomId, input.principalId, agentId],
      )
    ).rows[0];
    return row
      ? {
          workspaceId: row.workspace_id,
          member: Boolean(row.role),
          ...(row.role ? { role: row.role } : {}),
          ...(row.kind ? { principalKind: row.kind } : {}),
          archived: row.archived,
          // An agent is a server-validated Room member and is never gated by the
          // owner's cost policy; only a human sender answers to it. With no
          // `agents` row the server has nothing to say and says nothing: the
          // field is absent and the helper keeps its own reading.
          ...(row.access_policy === null
            ? {}
            : {
                mayAddressAgent:
                  row.kind === 'agent' ||
                  senderMayAddressAgent(
                    parseAgentAccessPolicy(row.access_policy),
                    input.principalId,
                    row.owner_id ?? undefined,
                  ),
              }),
        }
      : { workspaceId: input.roomId, member: false, archived: true };
  }
  private async permissionAuthority(input: Input<'getPermissionAuthority'>) {
    const row = (
      await this.database.query<{ status: string; generation: string }>(
        `SELECT status,generation FROM permission_authority WHERE permission_id=$1 AND room_id=$2 AND principal_id=$3 AND ($4::text IS NULL OR action_id=$4)`,
        [input.permissionId, input.roomId, input.principalId, input.actionId ?? null],
      )
    ).rows[0];
    return row
      ? {
          status:
            row.status === 'authorized'
              ? 'authorized'
              : row.status === 'denied'
                ? 'denied'
                : 'unavailable',
          generation: Number(row.generation),
        }
      : { status: 'unavailable' as const };
  }
  private async missionAuthority(input: Input<'getMissionAuthority'>) {
    const row = (
      await this.database.query<{
        status: 'authorized' | 'denied' | 'unavailable';
        generation: string;
      }>(
        `SELECT status,generation FROM mission_authority WHERE mission_id=$1 AND room_id=$2 AND principal_id=$3 AND exercise=$4`,
        [input.missionId, input.roomId, input.principalId, input.exercise],
      )
    ).rows[0];
    return row
      ? { status: row.status, generation: Number(row.generation) }
      : { status: 'unavailable' as const };
  }
  private async schedules(input: Input<'listAgentToolSchedules'>, agentId: string) {
    const roomId = (input as { roomId?: string }).roomId;
    const rows = await this.database.query<{
      schedule_id: string;
      revision: number;
      schedule: { status: string; nextRunAt?: number };
    }>(
      `SELECT schedule_id,revision,schedule FROM work_schedules WHERE agent_id=$1 ${roomId ? 'AND room_id=$2' : ''} ORDER BY updated_at`,
      roomId ? [agentId, roomId] : [agentId],
    );
    return {
      schedules: rows.rows.map((row) => ({
        scheduleId: row.schedule_id,
        revision: row.revision,
        status: row.schedule.status,
        ...(row.schedule.nextRunAt ? { nextRunAt: row.schedule.nextRunAt } : {}),
      })),
    };
  }
  private async scheduleAuthority(input: Input<'getWorkScheduleAuthority'>, agentId: string) {
    if (input.agentId !== agentId) return { status: 'denied' as const };
    const row = await this.database.query<{ authority_status: string }>(
      `SELECT authority_status FROM work_schedules WHERE schedule_id=$1 AND revision=$2 AND agent_id=$3 AND room_id=$4`,
      [input.scheduleId, input.revision, agentId, input.roomId],
    );
    return {
      status:
        row.rows[0]?.authority_status === 'authorized'
          ? ('authorized' as const)
          : ('unavailable' as const),
    };
  }
  private async mandate(input: Input<'getAgentToolMandate'>, agentId: string) {
    const row = (
      await this.database.query<{ generation: string; mandate: { expiresAt?: number } }>(
        `SELECT generation,mandate FROM agent_mandates WHERE agent_id=$1 AND room_id=$2`,
        [agentId, input.roomId],
      )
    ).rows[0];
    return row && (!row.mandate.expiresAt || row.mandate.expiresAt > Date.now())
      ? { status: 'valid' as const, generation: Number(row.generation) }
      : { status: row ? ('invalid' as const) : ('unavailable' as const) };
  }
  private async targetAuthority(input: Input<'getTargetAgentAuthority'>, agentId: string) {
    if (input.controllerAgentId !== agentId) return { status: 'denied' as const };
    const controller = await this.database.query(
      `SELECT 1 FROM memberships c JOIN memberships t ON t.room_id=c.room_id WHERE c.room_id=$1 AND c.identity_id=$2 AND t.identity_id=$3 AND c.removed_at IS NULL AND t.removed_at IS NULL`,
      [input.roomId, agentId, input.targetAgentId],
    );
    return { status: controller.rowCount ? ('authorized' as const) : ('denied' as const) };
  }
  /**
   * The corners of this Room that this agent may carry.
   *
   * A corner operates as a Room: the branch on GitHub is the shared artifact
   * and MEMBERSHIP is the authority, so every member agent lists the corner
   * and can be addressed in it. `corner_facts.owner_agent_id` survives as the
   * historical "opened by" — it still names `createdBy` here, and the phone
   * still shows it — but it no longer decides who may work. Listing on the
   * opener alone is what made the motivating incident silent: a helper that
   * never learns a corner exists never polls it, so a mention that resolved
   * perfectly produced no turn and no error.
   *
   * The opener is read with the same fallback `getAgentConfiguration` uses to
   * decide `reviewerHandle` — `COALESCE(owner_agent_id, created_by)` — because
   * the two answers meet in the reviewer's session. A corner whose
   * `owner_agent_id` predates the backfill would otherwise be reported as
   * opened by whoever happens to be polling, and a reviewer told by one query
   * that it holds the post is told by the other that it wrote the code: the
   * turn boots without `BEELINE_CORNER_REVIEWER`, `approve_merge` is filtered
   * off its surface, and its PASS can only ever be prose while the gate stays
   * at `approvalPending=true`. Reconciliation resurrects exactly the old heads
   * where that record is thinnest, so the two derivations must agree.
   */
  private async corners(roomId: string, agentId: string) {
    await this.access(roomId, agentId);
    const rows = await this.database.query<{
      id: string;
      parent_id: string;
      created_by: string | null;
      archived: boolean;
      closed_at: Date | null;
      lifecycle: import('@beeline/api-contract/phone').CornerLifecycleView;
      name: string;
      objective: string;
    }>(
      `SELECT r.id,r.parent_id,r.name,r.archived_at closed_at,f.objective,f.lifecycle,
              COALESCE(f.owner_agent_id,r.created_by) created_by,
              r.archived_at IS NOT NULL archived
       FROM rooms r JOIN corner_facts f ON f.corner_id=r.id
       JOIN memberships m ON m.room_id=r.id AND m.identity_id=$2 AND m.removed_at IS NULL
       WHERE r.parent_id=$1`,
      [roomId, agentId],
    );
    return {
      corners: rows.rows.map((row) => ({
        cornerId: row.id,
        parentRoomId: row.parent_id,
        createdBy: row.created_by ?? agentId,
        archived: row.archived,
        ...(row.closed_at
          ? { closedAt: Math.floor(new Date(row.closed_at).getTime() / 1_000) }
          : {}),
        ...(row.lifecycle?.pr?.number ? { pullRequestNumber: row.lifecycle.pr.number } : {}),
        ...(row.lifecycle?.pr?.mergeCommitSha
          ? { mergeCommitSha: row.lifecycle.pr.mergeCommitSha }
          : {}),
        name: row.name,
        objective: row.objective,
      })),
    };
  }
  private async cornerRestore(cornerId: string, agentId: string) {
    await this.access(cornerId, agentId);
    const row = (
      await this.database.query<{
        objective: string;
        title: string;
        kind: 'agent' | 'human';
        feature_branch: string | null;
        request_id: string | null;
        close_requested: boolean;
        lane: string | null;
        requester_handle: string | null;
        lifecycle: import('@beeline/api-contract/phone').CornerLifecycleView;
        pull_request_number: number | null;
        approval_head_sha: string | null;
      }>(
        `SELECT fact.objective,room.name title,fact.kind,fact.feature_branch,fact.request_id,fact.close_requested,fact.lifecycle,
           fact.lane,requester.handle requester_handle,
           approval.pull_request_number,approval.head_sha approval_head_sha
         FROM corner_facts fact
         JOIN rooms room ON room.id=fact.corner_id
         LEFT JOIN corner_merge_approvals approval ON approval.corner_id=fact.corner_id
         LEFT JOIN identities requester ON requester.id=fact.commissioned_by
         WHERE fact.corner_id=$1`,
        [cornerId],
      )
    ).rows[0];
    return {
      cornerId,
      objective: row?.objective ?? '',
      ...(row ? { title: row.title, kind: row.kind } : {}),
      ...(row?.feature_branch ? { featureBranch: row.feature_branch } : {}),
      ...(row?.request_id ? { requestId: row.request_id } : {}),
      closeRequested: row?.close_requested ?? false,
      // A row written before the lane existed reads back as its backfilled
      // default, never as an unknown third lane.
      lane:
        row?.lane === 'no_code'
          ? ('no_code' as const)
          : row?.lane === 'research'
            ? ('research' as const)
            : ('code' as const),
      ...(row?.requester_handle ? { requesterHandle: row.requester_handle } : {}),
      ...(row?.lifecycle ? { lifecycle: row.lifecycle } : {}),
      ...(row?.pull_request_number && row.approval_head_sha
        ? {
            mergeApproval: {
              pullRequestNumber: row.pull_request_number,
              headSha: row.approval_head_sha,
            },
          }
        : {}),
    };
  }
  private async approveCornerMerge(input: Input<'approveCornerMerge'>, agentId: string) {
    const target = (
      await this.database.query<{
        pull_request_number: number | null;
        head_sha: string | null;
      }>(
        `SELECT (fact.lifecycle->'pr'->>'number')::int pull_request_number,
                fact.lifecycle->'pr'->>'headSha' head_sha
         FROM rooms corner
         JOIN rooms parent ON parent.id=corner.parent_id
         JOIN corner_facts fact ON fact.corner_id=corner.id
         JOIN memberships reviewer ON reviewer.room_id=parent.id
           AND reviewer.identity_id=$2 AND reviewer.removed_at IS NULL
         JOIN identities identity ON identity.id=reviewer.identity_id AND identity.kind='agent'
         WHERE corner.id=$1 AND parent.reviewer_agent_id=$2`,
        [input.cornerId, agentId],
      )
    ).rows[0];
    if (!target) throw new Error('corner reviewer approval denied');
    if (!target.pull_request_number || !target.head_sha)
      throw new Error('corner has no pull request');
    if (target.head_sha !== input.headSha)
      throw new Error('pull request head changed; review the current head before approving');
    await recordCornerMergeApproval(this.database, {
      cornerId: input.cornerId,
      approvedBy: agentId,
      force: false,
      pullRequestNumber: target.pull_request_number,
      headSha: target.head_sha,
    });
    return {
      pullRequestNumber: target.pull_request_number,
      headSha: target.head_sha,
      status: 'approved' as const,
    };
  }
  private async repository(roomId: string, agentId: string) {
    await this.access(roomId, agentId);
    const row = (
      await this.database.query<{
        repository_key: string | null;
        repository_remote: string | null;
        repository_target_branch: string;
        repository_resolution: 'repository' | 'none' | 'unverified';
        direct_participants: string[] | null;
      }>(
        `SELECT repository_key,repository_remote,repository_target_branch,repository_resolution,direct_participants FROM rooms WHERE id=$1`,
        [roomId],
      )
    ).rows[0];
    if (row?.repository_resolution === 'unverified') return { resolution: 'unverified' as const };
    if (row?.repository_resolution === 'repository' || row?.repository_key)
      return {
        key: row.repository_key ?? undefined,
        remote: row.repository_remote ?? undefined,
        targetBranch: row.repository_target_branch,
        resolution: 'repository' as const,
      };
    return {
      resolution: 'none' as const,
      ...(row?.direct_participants?.length === 2
        ? { directParticipants: row.direct_participants }
        : {}),
    };
  }
  private async targetBranch(roomId: string, agentId: string) {
    await this.access(roomId, agentId);
    const row = (
      await this.database.query<{ repository_target_branch: string; updated_at: Date }>(
        `SELECT repository_target_branch,updated_at FROM rooms WHERE id=$1`,
        [roomId],
      )
    ).rows[0];
    if (!row) throw new Error('room not found');
    return { targetBranch: row.repository_target_branch, updatedAt: seconds(row.updated_at) };
  }
  private async identitySuccession(identityId: string) {
    const rows = await this.database.query<{ old_identity_id: string; new_identity_id: string }>(
      `SELECT old_identity_id,new_identity_id FROM identity_successions`,
    );
    const next = new Map(rows.rows.map((row) => [row.old_identity_id, row.new_identity_id]));
    let current = identityId;
    const predecessors: string[] = [];
    const seen = new Set<string>();
    while (next.has(current) && !seen.has(current)) {
      seen.add(current);
      predecessors.push(current);
      current = next.get(current)!;
    }
    return { currentIdentityId: current, predecessors };
  }
  private async configuration(agentId: string, roomId?: string) {
    if (roomId) await this.access(roomId, agentId);
    const row = (
      await this.database.query<{
        soul: { name: string; instructions: string } | null;
        selected_model: string | null;
        selected_effort: string | null;
        commands: Array<{ name: string; description?: string; inputHint?: string }>;
        yolo_mode: boolean;
        reviewer_handle: string | null;
      }>(
        `SELECT a.soul,a.selected_model,a.selected_effort,a.commands,
                CASE WHEN workspace.visibility='public' THEN false ELSE a.yolo_mode END yolo_mode,
                CASE WHEN room.parent_id IS NOT NULL
                           AND reviewer.id<>COALESCE(fact.owner_agent_id,room.created_by)
                     THEN reviewer.handle END reviewer_handle
         FROM agents a
         LEFT JOIN rooms room ON room.id=$2
         LEFT JOIN workspaces workspace ON workspace.id=room.workspace_id
         LEFT JOIN rooms parent ON parent.id=room.parent_id
         LEFT JOIN corner_facts fact ON fact.corner_id=room.id
         LEFT JOIN identities reviewer
           ON reviewer.id=parent.reviewer_agent_id AND reviewer.kind='agent'
         WHERE a.agent_id=$1`,
        [agentId, roomId],
      )
    ).rows[0];
    return {
      ...(row?.soul ? { soul: { name: row.soul.name, instructions: row.soul.instructions } } : {}),
      ...(row?.selected_model ? { model: row.selected_model } : {}),
      ...(row?.selected_effort ? { effort: row.selected_effort } : {}),
      commands: row?.commands ?? [],
      yoloMode: row?.yolo_mode ?? false,
      ...(row?.reviewer_handle ? { reviewerHandle: row.reviewer_handle } : {}),
    };
  }
  private async presence(input: Input<'getAgentPresence'>, agentId: string) {
    const row = (
      await this.database.query<{
        body: {
          status: 'online' | 'offline';
          observedAt: number;
          releaseVersion?: string;
          sourceSha?: string;
        };
        updated_at: Date;
      }>(
        `SELECT body,updated_at FROM live_outputs WHERE agent_id=$1 AND kind='presence' ORDER BY updated_at DESC LIMIT 1`,
        [agentId],
      )
    ).rows[0];
    return row
      ? {
          status:
            row.body.status === 'online' &&
            Date.now() - row.updated_at.getTime() < AGENT_REACHABLE_HORIZON_MS
              ? 'online'
              : 'offline',
          observedAt: row.body.observedAt,
          ...(row.body.releaseVersion ? { releaseVersion: row.body.releaseVersion } : {}),
          ...(row.body.sourceSha ? { sourceSha: row.body.sourceSha } : {}),
        }
      : { status: 'dormant' as const };
  }

  /** Public, secret-free release gate over active agent registrations. */
  async releaseReadiness() {
    const result = await this.database.query<{
      agent_id: string;
      updated_at: Date | null;
      body: {
        status?: string;
        observedAt?: number;
        releaseVersion?: string;
        sourceSha?: string;
      } | null;
    }>(
      `SELECT a.agent_id,lo.body,lo.updated_at
       FROM agents a
       LEFT JOIN LATERAL(
         SELECT body,updated_at FROM live_outputs
         WHERE agent_id=a.agent_id AND kind='presence'
         ORDER BY updated_at DESC LIMIT 1
       )lo ON true
       WHERE EXISTS(
         SELECT 1 FROM memberships m
         WHERE m.identity_id=a.agent_id AND m.room_id IS NULL AND m.removed_at IS NULL
       )
       ORDER BY a.agent_id`,
    );
    const daemons = result.rows.map((row) => {
      const body = row.body;
      const observedAt = body?.observedAt;
      const state = !body
        ? 'never-seen'
        : body.status !== 'online' ||
            !row.updated_at ||
            Date.now() - row.updated_at.getTime() >= AGENT_REACHABLE_HORIZON_MS
          ? 'offline'
          : 'ready';
      return {
        agentPubkey: row.agent_id,
        state,
        ...(typeof observedAt === 'number' ? { observedAt } : {}),
        ...(row.body?.releaseVersion ? { version: row.body.releaseVersion } : {}),
        ...(row.body?.sourceSha ? { sha: row.body.sourceSha } : {}),
      };
    });
    const summary = { total: 0, ready: 0, neverSeen: 0 };
    for (const daemon of daemons) {
      summary.total += 1;
      if (daemon.state === 'ready') summary.ready += 1;
      if (daemon.state === 'never-seen') summary.neverSeen += 1;
    }
    return { daemons, summary };
  }
  private async completion(input: Input<'getRequestCompletion'>, agentId: string) {
    await this.access(input.roomId, agentId);
    const row = (
      await this.database.query<{ corner_id: string | null; complete: boolean }>(
        `SELECT (SELECT id::text FROM rooms WHERE parent_id=$1 AND EXISTS(SELECT 1 FROM corner_facts WHERE corner_id=rooms.id AND request_id=$2) LIMIT 1) corner_id,EXISTS(SELECT 1 FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND status IN('complete','failed')) complete`,
        [input.roomId, input.requestId],
      )
    ).rows[0]!;
    return { ...(row.corner_id ? { openedCornerId: row.corner_id } : {}), completed: row.complete };
  }
  /** Only an explicit question may carry a corner answer into its parent Room. */
  private async isCornerQuestionReply(roomId: string, agentId: string, requestId: unknown) {
    if (typeof requestId !== 'string') return false;
    const result = await this.database.query(
      `SELECT 1 FROM agent_commands command JOIN messages source ON source.id=command.source_message_id
       WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3
         AND command.reason='relay_question' AND source.card_type='relay' LIMIT 1`,
      [roomId, agentId, requestId],
    );
    return Boolean(result.rowCount);
  }
  private async getCornerAsk(input: Input<'getCornerAsk'>, agentId: string) {
    await this.access(input.roomId, agentId);
    const ask = (
      await this.database.query<{
        corner_id: string;
        question: string;
        archived: boolean;
        answer: string | null;
      }>(
        `SELECT question.room_id corner_id,question.text question,
              corner.archived_at IS NOT NULL archived,answer.text answer
       FROM messages question JOIN rooms corner ON corner.id=question.room_id
       LEFT JOIN LATERAL (
         SELECT report.text FROM messages report
         WHERE report.room_id=$1 AND report.card_type='relay'
           AND report.card->>'direction'='up' AND report.card->>'askId'=question.id
           AND report.card->>'unanswered' IS DISTINCT FROM 'true'
         ORDER BY report.created_at,report.id LIMIT 1
       ) answer ON true
       WHERE question.id=$2 AND question.card_type='relay'
         AND question.card->>'reply'='once' AND corner.parent_id=$1
         AND question.author_id=$3`,
        [input.roomId, input.askId, agentId],
      )
    ).rows[0];
    if (!ask) throw new Error('corner ask not found');
    return {
      askId: input.askId,
      cornerId: ask.corner_id,
      question: ask.question,
      status:
        ask.answer !== null
          ? ('answered' as const)
          : ask.archived
            ? ('unanswered' as const)
            : ('pending' as const),
      ...(ask.answer !== null ? { answer: ask.answer } : {}),
    };
  }

  private async postCornerQuestionReport(command: CommandRow, answerId: string, agentId: string) {
    if (command.reason !== 'relay_question') return;
    const source = (
      await this.database.query<{
        room_id: string;
        ask_id: string;
        asking_agent_id: string;
        text: string;
        card: { fromRoomId?: string; reply?: string };
        parent_id: string;
        corner_name: string;
        answer: string;
      }>(
        `SELECT source.id ask_id,source.author_id asking_agent_id,source.room_id,source.text,source.card,corner.parent_id,corner.name corner_name,
                answer.text answer
         FROM messages source JOIN rooms corner ON corner.id=source.room_id
         JOIN messages answer ON answer.id=$2 AND answer.room_id=corner.id
         WHERE source.id=$1 AND source.card_type='relay' AND corner.archived_at IS NULL
         FOR SHARE OF corner`,
        [command.source_message_id, answerId],
      )
    ).rows[0];
    if (!source || source.card?.reply !== 'once' || source.card.fromRoomId !== source.parent_id)
      throw new Error('corner question source is invalid');
    const anchor = (
      await this.database.query<{ id: string }>(
        `SELECT id FROM messages WHERE room_id=$1 AND card_type='daemon-fact'
           AND card->>'type'='corner-open' AND card->>'cornerId'=$2
         ORDER BY created_at,id LIMIT 1`,
        [source.parent_id, source.room_id],
      )
    ).rows[0]?.id;
    const reportId = id();
    await this.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES($1,$2,$3,$4,'card','relay',$5::jsonb)`,
      [
        reportId,
        source.parent_id,
        agentId,
        source.answer,
        JSON.stringify({
          fromRoomId: source.room_id,
          toRoomId: source.parent_id,
          direction: 'up',
          fromName: source.corner_name,
          cornerId: source.room_id,
          askId: source.ask_id,
          answerMessageId: answerId,
          ...(anchor ? { anchorMessageId: anchor } : {}),
          received: true,
        }),
      ],
    );
    await createAgentCommand(this.database, {
      roomId: source.parent_id,
      agentId: source.asking_agent_id,
      sourceMessageId: reportId,
      reason: 'relay_answer',
      parent: command,
      retainDepth: true,
    });
    this.live.publish({ type: 'invalidate', roomId: source.parent_id, reason: 'message', agentId });
  }

  /** A hand-off is an intermediate command output, never the sender's final reply. */
  private async postRelay(input: Input<'postRoomMessage'>, agentId: string) {
    const relay = input.relay!;
    if (
      !relay ||
      !['down', 'up'].includes(relay.direction) ||
      relay.fromRoomId !== input.roomId ||
      typeof relay.toRoomId !== 'string' ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > 16000 ||
      (relay.reply !== undefined && relay.reply !== 'once')
    )
      throw new Error('invalid relay');
    if (relay.direction === 'up') throw new Error('relay up is retired');
    const command = this.authorizedCommand;
    if (!this.commandTransaction || !command) throw new Error('relay requires an active command');
    const cornerId = relay.toRoomId;
    const roomId = relay.fromRoomId;
    // Lock both current memberships and rooms against removal/closure for the whole write.
    const pair = (
      await this.database.query<{
        room_name: string;
        owner_agent_id: string;
      }>(
        `SELECT parent.name room_name,f.owner_agent_id
       FROM rooms corner JOIN rooms parent ON parent.id=corner.parent_id
       JOIN corner_facts f ON f.corner_id=corner.id
       JOIN memberships cm ON cm.room_id=corner.id AND cm.identity_id=$3 AND cm.removed_at IS NULL
       JOIN memberships pm ON pm.room_id=parent.id AND pm.identity_id=$3 AND pm.removed_at IS NULL
       WHERE corner.id=$1 AND parent.id=$2 AND parent.parent_id IS NULL
         AND corner.archived_at IS NULL AND parent.archived_at IS NULL
       FOR SHARE OF corner,parent,cm,pm`,
        [cornerId, roomId, agentId],
      )
    ).rows[0];
    if (!pair) throw new Error('relay requires current Room and corner membership');
    const target = pair.owner_agent_id;
    const received = Boolean(
      (
        await this.database.query(
          `SELECT 1 FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND status='working'
       AND created_at>now()-interval '90 seconds' LIMIT 1`,
          [relay.toRoomId, target],
        )
      ).rowCount,
    );
    const card = {
      fromRoomId: relay.fromRoomId,
      toRoomId: relay.toRoomId,
      direction: relay.direction,
      fromName: pair.room_name,
      cornerId,
      received,
      ...(relay.reply === 'once' ? { reply: 'once' } : {}),
    };
    const saved = (
      await this.database.query<{ id: string; created_at: Date }>(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,reply_to_message_id,root_message_id)
       VALUES($1,$2,$3,$4,'card','relay',$5::jsonb,$6,$6) RETURNING id,created_at`,
        [id(), relay.toRoomId, agentId, input.text.trim(), JSON.stringify(card), null],
      )
    ).rows[0]!;
    const queued = await createAgentCommand(this.database, {
      roomId: relay.toRoomId,
      agentId: target,
      sourceMessageId: saved.id,
      parent: command,
      reason: relay.reply === 'once' ? 'relay_question' : 'relay_steer',
    });
    if (!queued) throw new Error('relay target unavailable or delegation limit reached');
    this.live.publish({ type: 'invalidate', roomId: relay.toRoomId, reason: 'message', agentId });
    return { id: saved.id, createdAt: seconds(saved.created_at) };
  }
  private async postRoomMessage(
    input: Input<'postRoomMessage'>,
    agentId: string,
    atomicCommandWrite = false,
  ) {
    if (!this.commandTransaction && !atomicCommandWrite) await this.access(input.roomId, agentId);
    if (input.relay !== undefined) return this.postRelay(input, agentId);
    const messageId = id();
    const parent = input.replyToMessageId
      ? (
          await this.database.query<{
            root_message_id: string | null;
            agent_hop_count: number;
            author_kind: 'human' | 'agent';
          }>(
            `SELECT message.root_message_id,message.agent_hop_count,identity.kind author_kind
             FROM messages message JOIN identities identity ON identity.id=message.author_id
             WHERE message.id=$1 AND message.room_id=$2`,
            [input.replyToMessageId, input.roomId],
          )
        ).rows[0]
      : undefined;
    if (input.replyToMessageId && !parent) throw new Error('reply parent is not in this room');
    const command = atomicCommandWrite
      ? undefined
      : (this.authorizedCommand ??
        (await authorizeCommandOutput(
          this.database,
          input.roomId,
          agentId,
          input.requestId,
          input.generationId,
        )));
    // A tag an agent writes reaches the person it names, exactly as a
    // human-authored one does: the same reading of the text, the same push
    // fan-out, the same highlight. There is no per-turn numeric cap, and no
    // list is frozen here — `message-mentions.ts` reads the tags back out of
    // this text whenever someone asks who it addresses, and carries the one
    // rule that is not a cap: a corner agent's turn reply never tags a person,
    // because the merge summary card already says the work is done.
    const rootMessageId = input.replyToMessageId
      ? (parent!.root_message_id ?? input.replyToMessageId)
      : null;
    // Turns are unthreaded by design. Count from the inbox item that woke this
    // agent, not the optional presentation reply parent; a human item starts a
    // fresh chain at zero.
    const hopCount = command?.agent_depth ?? 0;
    let messageWriteStartedAt: number | undefined;
    const saveCompatibilityReply = async (database: SqlDatabase) => {
      // Attachments queued this turn by beeline-agent post_artifact ride on this
      // final reply; they are drained exactly once, here.
      const pending = (
        await database.query<{
          url: string;
          name: string;
          mime_type: string;
          size: number;
        }>(
          `SELECT url,name,mime_type,size::integer AS size FROM agent_pending_attachments
           WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 AND generation_id=$4 ORDER BY created_at,id`,
          [input.roomId, agentId, input.requestId, input.generationId],
        )
      ).rows;
      if (pending.length)
        await database.query(
          `DELETE FROM agent_pending_attachments WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 AND generation_id=$4`,
          [input.roomId, agentId, input.requestId, input.generationId],
        );
      // A durable final Room reply is also the turn's terminal proof. This
      // makes the Room view settle even if the daemon is interrupted before
      // its redundant explicit complete receipt reaches the server.
      //
      // Command authorization has already rejected cancelled output. Keep the
      // receipt guard as a second terminal-state invariant inside this upsert.
      if (input.requestId) {
        const settled = await database.query(
          `INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
           VALUES($1,$2,$3,'complete',$4)
           ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET
             status='complete',created_at=now()
           WHERE agent_turns.status<>'cancelled'`,
          [input.roomId, input.requestId, agentId, input.generationId],
        );
        if (settled.rowCount)
          await settleTurnFailureLine(database, input.roomId, input.requestId, agentId);
      }
      const values = [
        messageId,
        input.roomId,
        agentId,
        input.text,
        // The daemon posts conversation (or a card); a system line is only
        // ever phrased by the server (`system-line.ts`).
        input.presentation === 'card' ? 'card' : 'message',
        input.requestId ?? null,
        JSON.stringify(input.tags ?? {}),
        input.replyToMessageId ?? null,
        rootMessageId,
        hopCount,
        JSON.stringify(
          pending.map((row) => ({
            url: row.url,
            name: row.name,
            mimeType: row.mime_type,
            size: row.size,
          })),
        ),
      ];
      if (this.commandTransaction) {
        return (
          await database.query<CommittedMessageLiveRow>(
            `WITH inserted AS (
               INSERT INTO messages(
                 id,room_id,author_id,text,presentation,request_id,legacy_event,
                 reply_to_message_id,root_message_id,agent_hop_count,attachments,agent_model
               ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,
                 (SELECT selected_model FROM agents WHERE agent_id=$3))
               RETURNING *
             ), completed AS (
               UPDATE agent_commands SET state='complete',completed_at=now(),result_message_id=inserted.id
               FROM inserted WHERE agent_commands.id=$12
             ), cleared AS (
               DELETE FROM live_outputs
               WHERE room_id=$2 AND agent_id=$3 AND turn_id=$6 AND kind IN ('draft','thought')
             )
             SELECT inserted.*,author.kind author_kind,author.name author_name,
               author.handle author_handle,author.avatar author_avatar,author.face_id author_face,
               ${taggedIdentityIdsSql('inserted')} tagged_ids
             FROM inserted JOIN identities author ON author.id=inserted.author_id`,
            [...values, command!.id],
          )
        ).rows[0]!;
      }
      return (
        await database.query<CommittedMessageLiveRow>(
          `WITH inserted AS (
             INSERT INTO messages(
               id,room_id,author_id,text,presentation,request_id,legacy_event,
               reply_to_message_id,root_message_id,agent_hop_count,attachments,agent_model
             ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,
               (SELECT selected_model FROM agents WHERE agent_id=$3))
             RETURNING *
           )
           SELECT inserted.*,author.kind author_kind,author.name author_name,
             author.handle author_handle,author.avatar author_avatar,author.face_id author_face,
             ${taggedIdentityIdsSql('inserted')} tagged_ids
           FROM inserted JOIN identities author ON author.id=inserted.author_id`,
          values,
        )
      ).rows[0]!;
    };
    let saved: CommittedMessageLiveRow;
    let databaseAwaitResolvedAt: number | undefined;
    let projectionCompletedAt: number | undefined;
    if (atomicCommandWrite) {
      type AtomicReplyResult = {
        outcome:
          | 'committed'
          | 'authority_rejected'
          | 'turn_cancelled'
          | 'already_completed'
          | 'result_conflict'
          | 'write_failed';
        row: (Omit<CommittedMessageLiveRow, 'created_at'> & { created_at: string }) | null;
        recovered_row:
          (Omit<CommittedMessageLiveRow, 'created_at'> & { created_at: string }) | null;
      };
      // One autocommit statement owns the lock, generation/lease/cancellation
      // decision, attachment drain, terminal turn/failure state, reply insert,
      // command completion, and live-output cleanup. PostgreSQL commits the
      // statement before query() resolves, so the live row remains authoritative.
      messageWriteStartedAt = Date.now();
      const query = await this.database.query<AtomicReplyResult>(
        `WITH candidate AS MATERIALIZED (
             SELECT command.*,
               EXISTS(SELECT 1 FROM agent_turns turn
                 WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
                   AND turn.request_id=command.turn_request_id AND turn.status='cancelled') turn_cancelled
             FROM agent_commands command
             WHERE command.room_id=$2 AND command.agent_id=$3 AND command.turn_request_id=$6
               AND command.action IN ('input','resume') AND command.generation_id=$10
             ORDER BY command.created_at DESC,command.id DESC LIMIT 1 FOR UPDATE OF command
           ), writable AS (
             SELECT * FROM candidate
             WHERE state='claimed' AND lease_expires_at>clock_timestamp() AND NOT turn_cancelled
           ), pending AS (
             DELETE FROM agent_pending_attachments attachment USING writable
             WHERE attachment.room_id=$2 AND attachment.agent_id=$3
               AND attachment.request_id=$6 AND attachment.generation_id=$10
             RETURNING attachment.url,attachment.name,attachment.mime_type,attachment.size,
               attachment.created_at,attachment.id
           ), attachment_payload AS (
             SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'url',url,'name',name,'mimeType',mime_type,'size',size::integer
             ) ORDER BY created_at,id),'[]'::jsonb) attachments FROM pending
           ), settled AS (
             INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
             SELECT room_id,turn_request_id,agent_id,'complete',$10 FROM writable
             ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET
               status='complete',created_at=now()
             WHERE agent_turns.status<>'cancelled'
             RETURNING 1
           ), recovered AS (
             UPDATE messages failure SET
               text=COALESCE('@'||NULLIF(agent.handle,''),failure.system_event->'subject'->>'name')||' answered after a retry',
               system_event=jsonb_set(
                 jsonb_set(failure.system_event,'{subject,name}',
                   to_jsonb(COALESCE('@'||NULLIF(agent.handle,''),failure.system_event->'subject'->>'name'))),
                 '{verb}',to_jsonb('answered after a retry'::text)
               ),
               card=jsonb_set(failure.card,'{state}',to_jsonb('recovered'::text))
             FROM settled,identities agent
             WHERE agent.id=$3 AND failure.room_id=$2 AND failure.card_type='turn-failed'
               AND failure.card->>'requestId'=$6 AND failure.card->>'agentId'=$3
               AND failure.card->>'state'='failed' AND false
             RETURNING failure.*
           ), recovered_public AS (
             SELECT recovered.*,author.kind author_kind,author.name author_name,
               author.handle author_handle,author.avatar author_avatar,author.face_id author_face,
               ${taggedIdentityIdsSql('recovered')} tagged_ids
             FROM recovered JOIN identities author ON author.id=recovered.author_id
           ), recovery_barrier AS (
             SELECT count(*) recovered_count,
               (jsonb_agg(to_jsonb(recovered_public))->0) recovered_row
             FROM recovered_public
           ), inserted AS (
             INSERT INTO messages(
               id,room_id,author_id,text,presentation,request_id,legacy_event,
               reply_to_message_id,root_message_id,agent_hop_count,attachments,agent_model
             ) SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,
                 writable.agent_depth,attachment_payload.attachments,
                 (SELECT selected_model FROM agents WHERE agent_id=$3)
               FROM writable,settled,attachment_payload,recovery_barrier
             RETURNING *
           ), completed AS (
             UPDATE agent_commands command SET
               state='complete',completed_at=now(),result_message_id=inserted.id
             FROM inserted WHERE command.id=(SELECT id FROM writable)
             RETURNING command.id
           ), cleared AS (
             DELETE FROM live_outputs output USING completed
             WHERE output.room_id=$2 AND output.agent_id=$3 AND output.turn_id=$6
               AND output.kind IN ('draft','thought')
           ), inserted_public AS (
             SELECT inserted.*,author.kind author_kind,author.name author_name,
               author.handle author_handle,author.avatar author_avatar,author.face_id author_face,
               ${taggedIdentityIdsSql('inserted')} tagged_ids
             FROM inserted JOIN identities author ON author.id=inserted.author_id
             CROSS JOIN completed
           ), existing_public AS (
             SELECT message.*,author.kind author_kind,author.name author_name,
               author.handle author_handle,author.avatar author_avatar,author.face_id author_face,
               ${taggedIdentityIdsSql('message')} tagged_ids
             FROM candidate JOIN messages message ON message.id=candidate.result_message_id
             JOIN identities author ON author.id=message.author_id
             WHERE candidate.state='complete' AND message.text=$4
           ), committed AS (
             SELECT * FROM inserted_public UNION ALL SELECT * FROM existing_public
           )
           SELECT 'committed'::text outcome,to_jsonb(committed) row,
             (SELECT recovered_row FROM recovery_barrier) recovered_row
           FROM committed
           UNION ALL
           SELECT CASE
             WHEN NOT EXISTS(SELECT 1 FROM candidate) THEN 'authority_rejected'
             WHEN (SELECT turn_cancelled FROM candidate) THEN 'turn_cancelled'
             WHEN (SELECT state FROM candidate)='complete'
               AND (SELECT result_message_id FROM candidate) IS NULL THEN 'already_completed'
             WHEN (SELECT state FROM candidate)='complete' THEN 'result_conflict'
             ELSE 'write_failed'
           END outcome,NULL::jsonb row,NULL::jsonb recovered_row
           WHERE NOT EXISTS(SELECT 1 FROM committed)
           LIMIT 1`,
        [
          messageId,
          input.roomId,
          agentId,
          input.text,
          input.presentation === 'card' ? 'card' : 'message',
          input.requestId ?? null,
          JSON.stringify(input.tags ?? {}),
          input.replyToMessageId ?? null,
          rootMessageId,
          input.generationId,
        ],
      );
      if (this.livePaintDiagnostics) databaseAwaitResolvedAt = Date.now();
      const result = query.rows[0];
      if (!result || result.outcome === 'write_failed')
        throw new Error('command output authority rejected');
      if (result.outcome === 'authority_rejected')
        throw new Error('command output authority rejected');
      if (result.outcome === 'turn_cancelled') throw new Error('command turn cancelled');
      if (result.outcome === 'already_completed') throw new Error('command already completed');
      if (result.outcome === 'result_conflict') throw new Error('command result conflict');
      if (!result.row) throw new Error('command output authority rejected');
      saved = { ...result.row, created_at: new Date(result.row.created_at) };
      if (result.recovered_row) {
        const recovered = {
          ...result.recovered_row,
          created_at: new Date(result.recovered_row.created_at),
        };
        this.live.publish({
          type: 'invalidate',
          roomId: input.roomId,
          reason: 'message',
          agentId,
          messageId: recovered.id,
          committedRow: { type: 'message', row: recovered },
        });
      }
      if (this.livePaintDiagnostics) projectionCompletedAt = Date.now();
    } else {
      saved = await this.database.transaction(saveCompatibilityReply);
    }
    const emittedAt = Date.now();
    this.live.publish({
      type: 'invalidate',
      roomId: input.roomId,
      reason: 'message',
      agentId,
      messageId,
      committedRow: {
        type: 'message',
        row: saved,
        ...(messageWriteStartedAt ? { startedAt: messageWriteStartedAt } : {}),
      },
      ...(messageWriteStartedAt
        ? {
            trace: {
              id: randomBytes(16).toString('hex'),
              databaseAt: saved.created_at.getTime(),
              emittedAt,
              startedAt: messageWriteStartedAt,
              ...(databaseAwaitResolvedAt ? { databaseAwaitResolvedAt } : {}),
              ...(projectionCompletedAt ? { projectionCompletedAt } : {}),
              ...(this.livePaintDiagnostics && this.liveDiagnosticServerInstance
                ? { serverInstance: this.liveDiagnosticServerInstance }
                : {}),
            },
          }
        : {}),
    });
    return {
      id: saved.id,
      createdAt: seconds(saved.created_at),
    };
  }
  /** An agent-claimed attachment queued by post_artifact; stamped onto the agent's
   *  next final Room reply. Only media this agent uploaded through the daemon
   *  media endpoint may be queued. */
  private async postAgentAttachment(input: Input<'postAgentAttachment'>, agentId: string) {
    const attachment = input.attachment;
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment))
      throw new Error('attachment is required');
    if (typeof attachment.url !== 'string' || typeof attachment.name !== 'string')
      throw new Error('attachment url and name are required');
    if (
      typeof attachment.size !== 'number' ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size <= 0
    )
      throw new Error('attachment size is invalid');
    if (attachment.name.length > 512) throw new Error('attachment name is too long');
    if (typeof attachment.mimeType !== 'string' || attachment.mimeType.length > 255)
      throw new Error('attachment mimeType is invalid');
    const mediaId = MEDIA_URL_PATTERN.exec(attachment.url)?.[1];
    if (!mediaId) throw new Error('attachment url is not a server media reference');
    const owned = await this.database.query(
      `SELECT 1 FROM objects
        WHERE id=$1 AND owner_id=$2 AND state='ready' AND expires_at > now()`,
      [mediaId, agentId],
    );
    if (!owned.rowCount) throw new Error('attachment media is not owned by this agent');
    const queued = await this.database.query<{ total: string }>(
      `SELECT COALESCE(SUM(size),0)::text total FROM agent_pending_attachments
       WHERE room_id=$1 AND agent_id=$2`,
      [input.roomId, agentId],
    );
    if (Number(queued.rows[0]!.total) + attachment.size > this.mediaMaximumBytes)
      throw new Error('queued attachments exceed the size cap');
    await this.database.query(
      `INSERT INTO agent_pending_attachments(room_id,agent_id,url,name,mime_type,size,request_id,generation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.roomId,
        agentId,
        attachment.url,
        attachment.name,
        attachment.mimeType,
        attachment.size,
        input.requestId,
        input.generationId,
      ],
    );
    return this.writeResult();
  }
  private async liveOutput(
    kind: 'draft' | 'thought',
    input: Input<'postAgentDraft'>,
    agentId: string,
  ) {
    await this.access(input.roomId, agentId);
    const written = await this.database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       SELECT room.id,$2,$3,$4,$5::jsonb FROM rooms room
       WHERE room.id=$1 AND ($4<>'draft' OR room.parent_id IS NOT NULL)
       ON CONFLICT(room_id,agent_id,turn_id,kind)
       DO UPDATE SET body=EXCLUDED.body,updated_at=now()
       RETURNING 1`,
      [input.roomId, agentId, input.turnId, kind, JSON.stringify({ text: input.text })],
    );
    // Room turns keep their durable working receipt and final reply, but their
    // provisional prose stays off the transcript. Corners retain the full
    // draft stream so repository work remains observable while it is running.
    if (!written.rowCount) return this.writeResult();
    this.live.publish({
      type: kind,
      roomId: input.roomId,
      agentId,
      turnId: input.turnId,
      text: input.text,
    });
    return this.writeResult();
  }
  private async retract(input: Input<'retractAgentLiveOutput'>, agentId: string) {
    await this.database.query(
      `DELETE FROM live_outputs WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind=$4`,
      [input.roomId, agentId, input.turnId, input.kind],
    );
    this.live.publish({
      type: 'retract',
      roomId: input.roomId,
      agentId,
      turnId: input.turnId,
      kind: input.kind,
    });
    return this.writeResult();
  }
  private async turnReceipt(input: Input<'postAgentTurnReceipt'>, agentId: string) {
    await this.access(input.roomId, agentId);
    if (input.heartbeat && input.status !== 'working') {
      throw new Error('turn receipt heartbeat must be working');
    }
    if (input.completionKind && input.status !== 'complete') {
      throw new Error('turn receipt completion kind requires complete status');
    }
    const reason =
      input.status === 'failed' && typeof input.reason === 'string'
        ? input.reason.replace(/\s+/g, ' ').trim().slice(0, TURN_FAILURE_REASON_MAX) || null
        : null;
    let committedTurn: CommittedTurnLiveRow | undefined;
    let silence: { hiccupRestart: boolean; attempt: number } | undefined;
    await this.database.transaction(async (database) => {
      if (input.heartbeat) {
        committedTurn = (
          await database.query<CommittedTurnLiveRow>(
            `WITH written AS (
               UPDATE agent_turns SET created_at=now()
               WHERE room_id=$1 AND request_id=$2 AND agent_id=$3 AND status='working'
                 AND generation_id IS NOT DISTINCT FROM $4
               RETURNING room_id,request_id,agent_id,status,started_at,created_at,generation_id
             )
             SELECT written.*,requester.id requested_by FROM written
             LEFT JOIN messages trigger ON trigger.id=${turnRootMessageSql('written')}
             LEFT JOIN identities requester ON requester.id=trigger.author_id
               AND requester.kind='human'`,
            [input.roomId, input.requestId, agentId, input.generationId ?? null],
          )
        ).rows[0];
      } else {
        // `cancelled` is terminal and wins. The requester withdrew the question,
        // so the answer that arrives a moment later is an answer to nothing: a
        // helper that finishes its run mid-stop must not overwrite the stop with
        // `complete`, nor turn the cancelled turn into a failure it never was.
        // A refused write leaves `rowCount` at zero, which is also what keeps
        // the consequences below — the failure line, the settle — from running
        // over a turn the requester already stopped.
        const written = await database.query<CommittedTurnLiveRow>(
          `WITH written AS (
             INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id,failure_reason)
             VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET
               status=EXCLUDED.status,generation_id=EXCLUDED.generation_id,
               failure_reason=EXCLUDED.failure_reason,created_at=now()
             WHERE agent_turns.status<>'cancelled'
             RETURNING room_id,request_id,agent_id,status,started_at,created_at,generation_id
           )
           SELECT written.*,requester.id requested_by FROM written
           LEFT JOIN messages trigger ON trigger.id=${turnRootMessageSql('written')}
           LEFT JOIN identities requester ON requester.id=trigger.author_id
             AND requester.kind='human'`,
          [
            input.roomId,
            input.requestId,
            agentId,
            input.status,
            input.generationId ?? null,
            reason,
          ],
        );
        if (!written.rowCount) return;
        committedTurn = written.rows[0];
      }
      if (input.status === 'failed') {
        silence = await this.inscribeTurnFailure(
          database,
          input.roomId,
          input.requestId,
          agentId,
          input.generationId,
          reason,
          input.reasonKind,
        );
      } else if (input.status === 'complete') {
        // A successful turn does not always post a durable message. A textless
        // Room turn that opened a corner settles through the server's corner
        // card alone, so the terminal receipt must own the same durable
        // live-lane cleanup as postRoomMessage. The daemon's earlier retract
        // is only a best-effort presentation signal and may never reach the
        // server.
        await database.query(
          `DELETE FROM live_outputs
           WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind IN ('draft','thought')`,
          [input.roomId, agentId, input.requestId],
        );
        await settleTurnFailureLine(database, input.roomId, input.requestId, agentId);
        if (input.completionKind === 'no-reply') {
          const agent = (
            await database.query<{ name: string }>(
              `SELECT COALESCE(NULLIF(name,''),'The agent') name FROM identities WHERE id=$1`,
              [agentId],
            )
          ).rows[0];
          const existing = await database.query(
            `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='turn-no-reply'
               AND card->>'requestId'=$2 AND card->>'agentId'=$3 LIMIT 1`,
            [input.roomId, input.requestId, agentId],
          );
          if (agent && !existing.rowCount) {
            await systemLine(database, {
              roomId: input.roomId,
              subject: { kind: 'agent', id: agentId, name: agent.name },
              verb: 'had nothing to add',
              consequence: 'this turn completed normally.',
              cardType: 'turn-no-reply',
              card: {
                requestId: input.requestId,
                agentId,
                state: 'complete',
                completionKind: 'no-reply',
              },
              afterMessageId: input.requestId,
            });
          }
        }
      }
    });
    this.live.publish({
      type: 'invalidate',
      roomId: input.roomId,
      reason: 'turn',
      agentId,
      requestId: input.requestId,
      ...(committedTurn ? { committedRow: { type: 'turn' as const, row: committedTurn } } : {}),
    });
    return this.writeResult(
      silence?.hiccupRestart ? { hiccupRestart: true, hiccupAttempt: silence.attempt } : undefined,
    );
  }
  /**
   * A failed turn is a fact the Room must carry. The approved first-silence
   * line is inscribed here; a hiccup reopens the original command so the
   * recovered helper answers without another human request. The line carries
   * NO mention — `background.ts` also excludes `turn-failed` rows outright.
   */
  private async inscribeTurnFailure(
    database: SqlDatabase,
    roomId: string,
    requestId: string,
    agentId: string,
    generationId: string | undefined,
    reason: string | null,
    reasonKind?: string,
  ) {
    return noteFirstSilence(database, this.live, {
      roomId,
      requestId,
      agentId,
      generationId,
      reason,
      reasonKind,
    });
  }
  private async activity(input: Input<'postAgentActivity'>, agentId: string) {
    await this.access(input.roomId, agentId);
    const key = input.cornerActivityKey;
    if (key !== undefined) {
      if (typeof key !== 'string' || !key || key.length > 200)
        throw new Error('invalid corner activity key');
    }
    if (key !== undefined || input.activity.some((item) => item.kind === 'output')) {
      const corner = await this.database.query(`SELECT 1 FROM corner_facts WHERE corner_id=$1`, [
        input.roomId,
      ]);
      if (!corner.rowCount)
        throw new Error(
          key !== undefined
            ? 'invalid corner activity key: a corner is required'
            : 'invalid output activity: a corner is required',
        );
    }
    const messageId = key
      ? createHash('sha256')
          .update(JSON.stringify(['corner-activity', input.roomId, agentId, input.requestId, key]))
          .digest('hex')
      : id();
    const activity = await this.database.transaction(async (database) => {
      const inserted = await database.query<{ id: string; created_at: Date }>(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,request_id,activity,agent_model)
         VALUES($1,$2,$3,'','activity',$4,$5::jsonb,
           CASE WHEN $6::boolean THEN $7::text
             ELSE (SELECT selected_model FROM agents WHERE agent_id=$3) END)
         ON CONFLICT(id) DO NOTHING
         RETURNING id,created_at`,
        [
          messageId,
          input.roomId,
          agentId,
          input.requestId,
          JSON.stringify(input.activity),
          input.agentModel !== undefined,
          input.agentModel ?? null,
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await database.query<{ id: string; created_at: Date }>(
            `SELECT id,created_at FROM messages
             WHERE id=$1 AND room_id=$2 AND author_id=$3 AND request_id=$4
               AND presentation='activity' AND activity=$5::jsonb`,
            [messageId, input.roomId, agentId, input.requestId, JSON.stringify(input.activity)],
          )
        ).rows[0];
      if (!row) throw new Error('corner activity ID conflicts with another message');
      if (inserted.rowCount) {
        await database.query(
          `UPDATE agent_turns SET created_at=now()
           WHERE room_id=$1 AND request_id=$2 AND agent_id=$3 AND status='working'`,
          [input.roomId, input.requestId, agentId],
        );
      }
      return { ...row, inserted: Boolean(inserted.rowCount) };
    });
    if (activity.inserted)
      this.live.publish({
        type: 'invalidate',
        roomId: input.roomId,
        reason: 'activity',
        agentId,
        messageId: activity.id,
      });
    return { id: activity.id, createdAt: seconds(activity.created_at) };
  }
  private async permissionRequest(input: Input<'postPermissionRequest'>, agentId: string) {
    await this.access(input.roomId, agentId);
    const scope = input.scope;
    const repository =
      scope.type === 'room.create'
        ? scope.repository?.key
        : scope.type === 'money.spend'
          ? scope.merchant
          : scope.type === 'schedule.change'
            ? scope.scheduleId
            : scope.type === 'mission.control'
              ? scope.missionId
              : scope.target;
    const tool =
      scope.type === 'operation.execute' ||
      scope.type === 'message.send' ||
      scope.type === 'content.publish'
        ? scope.connectorId
        : scope.type;
    const messageId = await this.database.transaction(async (database) => {
      const inserted = await database.query(
        `INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
         VALUES($1,$2,$3,$4,$5::jsonb,'pending') ON CONFLICT(permission_id) DO NOTHING
         RETURNING permission_id`,
        [
          input.permissionId,
          input.roomId,
          input.principalId,
          input.requestId,
          JSON.stringify(scope),
        ],
      );
      if (!inserted.rowCount) {
        return (
          await database.query<{ id: string }>(
            `SELECT id FROM messages WHERE room_id=$1 AND card_type='permission'
             AND card->>'permissionId'=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
            [input.roomId, input.permissionId],
          )
        ).rows[0]?.id;
      }
      const identities = await database.query<{
        id: string;
        kind: 'human' | 'agent';
        name: string;
        handle: string | null;
        avatar: string | null;
      }>(`SELECT id,kind,name,handle,avatar FROM identities WHERE id=ANY($1::text[])`, [
        [input.principalId, agentId],
      ]);
      const requesterRow = identities.rows.find((row) => row.id === input.principalId);
      const agentRow = identities.rows.find((row) => row.id === agentId);
      if (!requesterRow || requesterRow.kind !== 'human' || !agentRow || agentRow.kind !== 'agent')
        throw new Error('permission identities are invalid');
      const requester = {
        pubkey: requesterRow.id,
        kind: requesterRow.kind,
        name: requesterRow.name,
        ...(requesterRow.handle ? { handle: requesterRow.handle } : {}),
        ...(requesterRow.avatar ? { avatar: requesterRow.avatar } : {}),
      };
      const agent = {
        pubkey: agentRow.id,
        kind: agentRow.kind,
        name: agentRow.name,
        ...(agentRow.handle ? { handle: agentRow.handle } : {}),
        ...(agentRow.avatar ? { avatar: agentRow.avatar } : {}),
      };
      const created = id();
      await systemLine(database, {
        id: created,
        roomId: input.roomId,
        subject: { kind: 'agent', id: agentId, name: agent.name },
        verb: `asked ${requester.handle ? `@${requester.handle}` : ''} to`,
        object: tool,
        presentation: 'card',
        requestId: input.requestId,
        cardType: 'permission',
        card: {
          permissionId: input.permissionId,
          requestId: input.requestId,
          agent,
          requester,
          tool,
          ...(repository ? { repository } : {}),
          ...(scope.type === 'money.spend' ? { purpose: 'squire-spending' } : {}),
          status: 'pending',
        },
      });
      return created;
    });
    if (!messageId) throw new Error('permission request is invalid');
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'permission', agentId });
    return { id: messageId, createdAt: Math.floor(Date.now() / 1000) };
  }
  private async permissionExecution(input: Input<'postPermissionExecution'>, agentId: string) {
    await this.access(input.roomId, agentId);
    await this.database.query(
      `UPDATE permission_authority SET status=$2,result=$3,updated_at=now() WHERE permission_id=$1`,
      [input.permissionId, input.status, input.result ?? null],
    );
    return this.writeResult();
  }
  private async postSchedule(input: Input<'postWorkSchedule'>, agentId: string) {
    await this.access(input.roomId, agentId);
    await this.database.query(
      `INSERT INTO work_schedules(schedule_id,agent_id,room_id,revision,schedule) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(schedule_id,revision) DO UPDATE SET schedule=EXCLUDED.schedule,updated_at=now()`,
      [
        input.schedule.scheduleId,
        agentId,
        input.roomId,
        input.schedule.revision,
        JSON.stringify(input.schedule),
      ],
    );
    return this.writeResult();
  }
  /** Agent-driven schedules (beeline-agent create_schedule) run through the
   *  same agent_schedules loop as manager-created schedules, with the agent as
   *  both creator and beneficiary. */
  private async createAgentSchedule(input: Input<'createAgentSchedule'>, agentId: string) {
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
      throw new Error('schedule prompt is required');
    }
    validateScheduleCadence(input.cadence);
    if (
      input.maxRuns !== undefined &&
      (!Number.isSafeInteger(input.maxRuns) || (input.maxRuns as number) < 1)
    ) {
      throw new Error('maxRuns must be a positive integer');
    }
    const room = await this.database.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM rooms WHERE id=$1`,
      [input.roomId],
    );
    if (!room.rows[0]) throw new Error('schedule room not found');
    const scheduleId = randomUUID();
    const nextRunAt = nextScheduleOccurrence(input.cadence, new Date());
    await this.database.query(
      `INSERT INTO agent_schedules(
         id,workspace_id,room_id,agent_id,creator_id,cadence,message,max_runs,next_run_at
       ) VALUES($1,$2,$3,$4,$4,$5::jsonb,$6,$7,$8)`,
      [
        scheduleId,
        room.rows[0].workspace_id,
        input.roomId,
        agentId,
        JSON.stringify(input.cadence),
        input.prompt.trim(),
        input.maxRuns ?? null,
        nextRunAt,
      ],
    );
    return { scheduleId, nextRunAt: Math.floor(nextRunAt.getTime() / 1_000) };
  }
  /**
   * What this agent reacts to in this Room, set by the agent itself.
   *
   * The whole point of an event subscription is that an agent asked to greet
   * newcomers can start greeting newcomers without a person editing a database
   * row for it. The write is scoped by construction: the daemon token names the
   * agent, `roomId` names the Room, `execute` has already refused a Room this
   * agent is not a member of, and the UPDATE touches exactly that one
   * membership. Only server kinds may be subscribed to — an `agent:` kind is a
   * sentence some agent chose to say, and reacting to it is a mention, not a
   * subscription.
   */
  private async setEventSubscriptions(input: Input<'setEventSubscriptions'>, agentId: string) {
    const requested = Array.isArray(input.kinds) ? input.kinds : [];
    const unknown = requested.filter((kind) => !isServerEventKind(kind));
    if (unknown.length) {
      throw new Error(
        `not an event kind you can subscribe to: ${unknown.join(', ')}. ` +
          `The kinds are ${SERVER_EVENT_KINDS.join(', ')}.`,
      );
    }
    const kinds = [...new Set(requested)] as ServerEventKind[];
    const updated = await this.database.query<{ event_subscriptions: ServerEventKind[] }>(
      `UPDATE memberships member
       SET event_subscriptions=CASE WHEN parent.reviewer_agent_id=$2
         AND NOT $3::jsonb @> '["check-passed"]'::jsonb
         THEN $3::jsonb||'["check-passed"]'::jsonb ELSE $3::jsonb END
       FROM rooms surface
       JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id)
       WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL
         AND surface.id=member.room_id
       RETURNING member.event_subscriptions`,
      [input.roomId, agentId, JSON.stringify(kinds)],
    );
    if (!updated.rowCount) throw new Error('daemon room access denied');
    return { kinds: [...new Set(updated.rows[0]!.event_subscriptions)] };
  }
  private async listEventSubscriptions(input: Input<'listEventSubscriptions'>, agentId: string) {
    const rows = await this.database.query<{ event_subscriptions: unknown }>(
      `SELECT event_subscriptions FROM memberships
       WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
      [input.roomId, agentId],
    );
    const stored = rows.rows[0]?.event_subscriptions;
    const kinds = (Array.isArray(stored) ? stored : []).filter(isServerEventKind);
    return { kinds };
  }

  /**
   * One event this agent emits, with the cause the SERVER read for itself.
   *
   * The helper sends the kind, the sentence and who to wake; it never sends a
   * cause or a depth, because it is the agent's own process and a guard the
   * guarded party sets is not a guard. The cause is the request id on this
   * agent's live turn receipt in this Room — the message that woke it — so an
   * emit outside a turn has nothing to cite and is refused. `systemLine` then
   * derives the root and the depth from that row and refuses a cascade that has
   * run too deep or woken too many turns; the refusal writes nothing and comes
   * back out of here as the tool's error text.
   */
  private async postRoomEvent(input: Input<'postRoomEvent'>, agentId: string) {
    if (isServerEventKind(input.kind)) {
      throw new Error(
        `${input.kind} is a fact the server states, not one an agent emits. ` +
          'Use an agent:<slug> kind of your own.',
      );
    }
    if (!isAgentKind(input.kind)) {
      throw new Error(
        'kind must be agent:<slug>, lower-case letters, digits and hyphens, at most 40 characters',
      );
    }
    const consequence = typeof input.consequence === 'string' ? input.consequence.trim() : '';
    if (!consequence) throw new Error('an event needs one sentence saying what happened');
    if (consequence.length > MAX_EVENT_CONSEQUENCE_LENGTH)
      throw new Error(
        `the event sentence must be at most ${MAX_EVENT_CONSEQUENCE_LENGTH} characters`,
      );
    const wakes = [...new Set(input.mentionAgentIds ?? [])];
    if (wakes.length > MAX_MENTIONS_PER_EVENT)
      throw new Error(`an event may wake at most ${MAX_MENTIONS_PER_EVENT} agents`);
    if (wakes.length) {
      const members = await this.database.query<{ identity_id: string }>(
        `SELECT member.identity_id FROM memberships member
         JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
         WHERE member.room_id=$1 AND member.removed_at IS NULL
           AND member.identity_id=ANY($2::text[])`,
        [input.roomId, wakes],
      );
      const present = new Set(members.rows.map((row) => row.identity_id));
      const missing = wakes.filter((wake) => !present.has(wake));
      if (missing.length)
        throw new Error(`not an agent member of this Room: ${missing.join(', ')}`);
    }
    const active = await this.database.query<{ request_id: string }>(
      `SELECT request_id FROM agent_turns
       WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 AND status='working'
       ORDER BY created_at DESC LIMIT 1`,
      [input.roomId, agentId, input.requestId],
    );
    const causeId = active.rows[0]?.request_id;
    if (!causeId)
      throw new Error(
        'an event is emitted from inside a turn; this agent has no turn running here',
      );
    const self = await this.database.query<{ name: string }>(
      `SELECT COALESCE(NULLIF(name,''),'An agent') name FROM identities WHERE id=$1`,
      [agentId],
    );
    const line = await systemLine(this.database, {
      roomId: input.roomId,
      subject: { kind: 'agent', id: agentId, name: self.rows[0]?.name ?? 'An agent' },
      verb: 'emitted',
      object: input.kind.slice('agent:'.length),
      consequence,
      kind: input.kind,
      wakes,
      causeId,
      commandId: (
        await authorizeCommandOutput(
          this.database,
          input.roomId,
          agentId,
          input.requestId,
          input.generationId,
        )
      ).id,
    });
    return { id: line.id, createdAt: Math.floor(Date.now() / 1_000) };
  }
  private async listAgentSchedules(input: Input<'listAgentSchedules'>, agentId: string) {
    const rows = await this.database.query<{
      id: string;
      cadence: import('@beeline/api-contract/phone').RoomScheduleCadence;
      message: string;
      max_runs: number | null;
      run_count: number;
      next_run_at: Date;
    }>(
      `SELECT id,cadence,message,max_runs,run_count,next_run_at
       FROM agent_schedules WHERE room_id=$1 AND agent_id=$2 ORDER BY created_at,id`,
      [input.roomId, agentId],
    );
    return {
      schedules: rows.rows.map((row) => ({
        scheduleId: row.id,
        prompt: row.message,
        cadence: row.cadence,
        ...(row.max_runs !== null ? { maxRuns: row.max_runs } : {}),
        runCount: row.run_count,
        nextRunAt: Math.floor(row.next_run_at.getTime() / 1_000),
      })),
    };
  }
  private async deleteAgentSchedule(input: Input<'deleteAgentSchedule'>, agentId: string) {
    const deleted = await this.database.query(
      `DELETE FROM agent_schedules WHERE id=$1 AND room_id=$2 AND agent_id=$3`,
      [input.scheduleId, input.roomId, agentId],
    );
    if (!deleted.rowCount) throw new Error('schedule not found');
    return this.writeResult();
  }
  private async scheduleReceipt(input: Input<'postWorkScheduleReceipt'>, agentId: string) {
    await this.database.query(
      `INSERT INTO schedule_receipts(schedule_id,occurrence_id,agent_id,room_id,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [input.scheduleId, input.occurrenceId, agentId, input.roomId, input.status],
    );
    return this.writeResult();
  }
  private async scheduleIndex(input: Input<'postAgentToolScheduleIndex'>, agentId: string) {
    const member = await this.database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
      [input.workspaceId, agentId],
    );
    if (!member.rowCount) throw new Error('daemon workspace access denied');
    await this.database.query(
      `UPDATE agents SET schedule_ids=$2::jsonb,updated_at=now() WHERE agent_id=$1`,
      [agentId, JSON.stringify(input.scheduleIds)],
    );
    return this.writeResult();
  }
  private async postMandate(input: Input<'postAgentToolMandate'>, agentId: string) {
    await this.database.query(
      `INSERT INTO agent_mandates(agent_id,room_id,generation,mandate) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(agent_id,room_id) DO UPDATE SET generation=EXCLUDED.generation,mandate=EXCLUDED.mandate,updated_at=now()`,
      [agentId, input.roomId, input.generation, JSON.stringify(input.mandate)],
    );
    return this.writeResult();
  }
  private async commands(input: Input<'postAgentCommands'>, agentId: string) {
    await this.database.query(
      `UPDATE agents SET commands=$2::jsonb,updated_at=now() WHERE agent_id=$1`,
      [agentId, JSON.stringify(input.commands)],
    );
    return this.writeResult();
  }
  private async modelCatalog(input: Input<'postAgentModelCatalog'>, agentId: string) {
    await this.database.query(
      `UPDATE agents SET model_catalog=$2::jsonb,selected_model=COALESCE($3,selected_model),
         selected_effort=COALESCE($4,selected_effort),model_unavailable=$5,updated_at=now()
       WHERE agent_id=$1`,
      [
        agentId,
        JSON.stringify(input.options),
        input.selection?.model ?? null,
        input.selection?.effort ?? null,
        input.unavailable ?? null,
      ],
    );
    return this.writeResult();
  }
  private async machineReport(input: Input<'postAgentMachineReport'>, agentId: string) {
    await this.database.query(
      `UPDATE agents SET machine_id=$2,machine_name=$3,updated_at=now() WHERE agent_id=$1`,
      [agentId, input.machineId, input.machineName],
    );
    return this.writeResult();
  }
  private async cornerLifecycle(input: Input<'postCornerLifecycle'>, agentId: string) {
    await this.access(input.cornerId, agentId);
    await this.database.query(
      `INSERT INTO corner_facts(corner_id,objective,lifecycle) VALUES($1,$2,$3::jsonb) ON CONFLICT(corner_id) DO UPDATE SET objective=COALESCE(NULLIF(corner_facts.objective,''),EXCLUDED.objective),lifecycle=corner_facts.lifecycle||EXCLUDED.lifecycle,updated_at=now()`,
      [
        input.cornerId,
        input.objective,
        JSON.stringify({
          lifecycle: input.status,
          checks: 'unknown',
          ...(input.outcome ? { outcome: input.outcome } : {}),
        }),
      ],
    );
    return this.writeResult();
  }
  private async cornerRemote(input: Input<'postCornerRemoteState'>, agentId: string) {
    await this.access(input.cornerId, agentId);
    const lifecycle = {
      lifecycle: input.state === 'gone' ? 'done' : input.state,
      branch: input.branch,
      checks: input.checks,
      ...(input.pullRequest ? { pr: input.pullRequest } : {}),
    };
    await this.database.query(
      `INSERT INTO corner_facts(corner_id,feature_branch,lifecycle) VALUES($1,$2,$3::jsonb)
       ON CONFLICT(corner_id) DO UPDATE SET
         feature_branch=EXCLUDED.feature_branch,
         lifecycle=CASE
           -- A helper's restart heartbeat is lower authority than GitHub's PR/check facts.
           -- Keep the complete webhook-owned lifecycle so it cannot lose the PR, mergeability,
           -- or check summary; the branch remains the daemon's current local fact.
           WHEN EXCLUDED.lifecycle->>'lifecycle'='working' AND corner_facts.lifecycle ? 'pr'
             THEN corner_facts.lifecycle || jsonb_build_object('branch', EXCLUDED.lifecycle->'branch')
           ELSE corner_facts.lifecycle || EXCLUDED.lifecycle
         END,
         updated_at=now()`,
      [input.cornerId, input.branch, JSON.stringify(lifecycle)],
    );
    return this.writeResult();
  }
  private async cornerPlan(input: Input<'postCornerPlan'>, agentId: string) {
    await this.access(input.cornerId, agentId);
    const plan = { ...(input.objective ? { objective: input.objective } : {}), items: input.items };
    await this.database.query(
      `INSERT INTO corner_facts(corner_id,objective,plan) VALUES($1,$2,$3::jsonb) ON CONFLICT(corner_id) DO UPDATE SET objective=COALESCE(NULLIF(corner_facts.objective,''),NULLIF(EXCLUDED.objective,''),''),plan=EXCLUDED.plan,updated_at=now()`,
      [input.cornerId, input.objective ?? '', JSON.stringify(plan)],
    );
    return this.writeResult();
  }
  private async putCornerApp(input: Input<'putCornerApp'>, agentId: string) {
    await this.access(input.cornerId, agentId);
    const definition = readCornerAppDefinition(input.definition);
    if (!definition) throw new Error('corner app definition is invalid');
    const saved = (
      await this.database.query<{ revision: number; updated_at: Date }>(
        `INSERT INTO corner_apps(corner_id,slug,author_agent_id,definition)
         VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT(corner_id,slug) DO UPDATE SET
           author_agent_id=EXCLUDED.author_agent_id,
           definition=EXCLUDED.definition,
           revision=corner_apps.revision+1,
           updated_at=now()
         RETURNING revision,updated_at`,
        [input.cornerId, definition.slug, agentId, JSON.stringify(definition)],
      )
    ).rows[0]!;
    this.live.publish({
      type: 'invalidate',
      roomId: input.cornerId,
      reason: 'corner-app',
      agentId,
    });
    return {
      id: id(),
      createdAt: seconds(saved.updated_at),
      slug: definition.slug,
      revision: saved.revision,
    };
  }
  private async requestCornerAppOpen(input: Input<'requestCornerAppOpen'>, agentId: string) {
    await this.access(input.cornerId, agentId);
    const app = (
      await this.database.query<{ title: string; revision: number }>(
        `SELECT definition->>'title' title,revision FROM corner_apps
         WHERE corner_id=$1 AND slug=$2`,
        [input.cornerId, input.slug],
      )
    ).rows[0];
    if (!app) throw new Error('corner app not found');
    const agent = await this.identity(agentId);
    const messageId = id();
    await systemLine(this.database, {
      id: messageId,
      roomId: input.cornerId,
      subject: { kind: 'agent', id: agentId, name: agent.name },
      verb: 'opened an app',
      object: app.title,
      presentation: 'card',
      requestId: input.requestId,
      cardType: 'corner-app',
      card: { slug: input.slug, title: app.title, revision: app.revision },
    });
    this.live.publish({
      type: 'invalidate',
      roomId: input.cornerId,
      reason: 'corner-app',
      agentId,
    });
    return {
      id: messageId,
      createdAt: Math.floor(Date.now() / 1000),
      slug: input.slug,
      revision: app.revision,
    };
  }
  private async targetProposal(input: Input<'postTargetBranchProposal'>, agentId: string) {
    await this.access(input.roomId, agentId);
    const messageId = id();
    const agent = await this.identity(agentId);
    await systemLine(this.database, {
      id: messageId,
      roomId: input.roomId,
      subject: { kind: 'agent', id: agentId, name: agent.name },
      verb: 'proposed a target branch',
      object: input.to,
      consequence: `instead of ${input.from}`,
      presentation: 'card',
      requestId: input.requestId,
      cardType: 'target-branch',
      card: {
        proposalId: messageId,
        from: input.from,
        to: input.to,
        repository: input.repository,
        agent,
      },
    });
    return { id: messageId, createdAt: Math.floor(Date.now() / 1000) };
  }

  /**
   * request_grant: the agent raises its hand. Under yolo the grant is approved
   * on the spot (auto=true) and one quiet system line records it; otherwise a
   * pending grant is stored and joins (or opens) this agent's one open card in
   * the Room, addressed to the owner. Squire's host route asks in the owner's
   * connector DM. Budget always asks (the cap is out of scope), even under yolo.
   */
  private async requestAgentGrant(input: Input<'requestAgentGrant'>, agentId: string) {
    if (!isAgentGrantKind(input.kind)) throw new Error('grant kind is invalid');
    if (typeof input.target !== 'string' || !input.target.trim())
      throw new Error('grant target is required');
    if (input.target.length > AGENT_GRANT_TARGET_MAX_LENGTH)
      throw new Error('grant target is invalid: too long');
    if (typeof input.reason !== 'string' || !input.reason.trim())
      throw new Error('grant reason is required');
    if (input.reason.length > AGENT_GRANT_REASON_MAX_LENGTH)
      throw new Error('grant reason is invalid: too long');
    if (
      input.ttlSeconds !== undefined &&
      (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds <= 0)
    )
      throw new Error('grant ttlSeconds is invalid');
    const kind: AgentGrantKind = input.kind;
    const target = kind === 'command' ? input.target : input.target.trim();
    const squireRoute = kind === 'mcp' && target === 'squire';
    let rule: CommandGrantRule | undefined;
    if (kind === 'command') {
      try {
        rule = parseCommandGrantTarget(target);
      } catch (error) {
        throw new Error(
          `command target is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // C94: yolo is the scope gate and it is enough — except for the two hard
    // stops, which stand in a Room and in a corner whether yolo is on or not.
    const script = rule ? validateGrantScript(rule, input.script) : undefined;
    const escalations: AgentGrantEscalation[] = rule ? commandRuleEscalations(rule, script) : [];
    const reason = input.reason.trim();
    const context = (
      await this.database.query<{
        workspace_id: string;
        parent_id: string | null;
        owner_id: string;
        yolo_mode: boolean;
        agent_name: string;
        agent_handle: string | null;
        agent_avatar: string | null;
        owner_name: string;
        owner_handle: string | null;
        owner_avatar: string | null;
      }>(
        `SELECT room.workspace_id,room.parent_id,a.owner_id,
                CASE WHEN workspace.visibility='public' THEN false ELSE a.yolo_mode END yolo_mode,
                agent.name agent_name,agent.handle agent_handle,agent.avatar agent_avatar,
                owner.name owner_name,owner.handle owner_handle,owner.avatar owner_avatar
         FROM rooms room
         JOIN workspaces workspace ON workspace.id=room.workspace_id
         JOIN agents a ON a.agent_id=$2
         JOIN identities agent ON agent.id=a.agent_id
         JOIN identities owner ON owner.id=a.owner_id
         WHERE room.id=$1`,
        [input.roomId, agentId],
      )
    ).rows[0];
    if (!context) throw new Error('agent not found');
    // The requester is whoever addressed the agent last in this Room: the
    // identity whose message triggered the turn that is asking now. With no
    // such message (a fresh corner objective), the owner asked.
    //
    // Read from the command that woke this agent rather than by searching the
    // transcript for an address. The command IS the trigger, so it names the
    // right message even when nothing in that message's text spells a handle —
    // a scheduled prompt wakes the agent by subscription, and a search for a
    // written tag would walk straight past it to some older line.
    const sourceMessageId = this.authorizedCommand?.source_message_id;
    const requesterRow = (
      await this.database.query<{
        id: string;
        kind: 'human' | 'agent';
        name: string;
        handle: string | null;
        avatar: string | null;
      }>(
        `SELECT identity.id,identity.kind,identity.name,identity.handle,identity.avatar
         FROM agent_commands command
         JOIN messages message ON message.id=command.source_message_id
         JOIN identities identity ON identity.id=message.author_id
         WHERE command.room_id=$1 AND command.agent_id=$2 AND message.author_id<>$2
           AND message.presentation<>'activity'
           AND ($3::text IS NULL OR command.source_message_id=$3)
         ORDER BY command.created_at DESC,command.id DESC LIMIT 1`,
        [input.roomId, agentId, squireRoute ? (sourceMessageId ?? null) : null],
      )
    ).rows[0];
    const owner = {
      pubkey: context.owner_id,
      kind: 'human' as const,
      name: context.owner_name,
      ...(context.owner_handle ? { handle: context.owner_handle } : {}),
      ...(context.owner_avatar ? { avatar: context.owner_avatar } : {}),
    };
    const agent = {
      pubkey: agentId,
      kind: 'agent' as const,
      name: context.agent_name,
      ...(context.agent_handle ? { handle: context.agent_handle } : {}),
      ...(context.agent_avatar ? { avatar: context.agent_avatar } : {}),
    };
    const requester = requesterRow
      ? {
          pubkey: requesterRow.id,
          kind: requesterRow.kind,
          name: requesterRow.name,
          ...(requesterRow.handle ? { handle: requesterRow.handle } : {}),
          ...(requesterRow.avatar ? { avatar: requesterRow.avatar } : {}),
        }
      : owner;
    const grantId = randomUUID();
    const auto =
      context.yolo_mode && kind !== 'budget' && kind !== 'mcp' && escalations.length === 0;
    const status = auto ? 'approved' : 'pending';
    const result = await this.database.transaction(async (database) => {
      const inserted = await database.query<{ created_at: Date; expires_at: Date | null }>(
        `INSERT INTO agent_grants(
           id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,
           decided_at,expires_at,auto,script
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
           CASE WHEN $10::boolean THEN now() END,
           CASE WHEN $11::integer IS NULL THEN NULL ELSE now()+make_interval(secs=>$11::integer) END,
           $10,$12::jsonb)
         RETURNING created_at,expires_at`,
        [
          grantId,
          agentId,
          context.workspace_id,
          kind,
          target,
          reason,
          requester.pubkey,
          input.roomId,
          status,
          auto,
          input.ttlSeconds ?? null,
          script ? JSON.stringify(script) : null,
        ],
      );
      const row = inserted.rows[0]!;
      const grantView = {
        grantId,
        kind,
        target,
        reason,
        status,
        requestedBy: requester,
        roomId: input.roomId,
        createdAt: seconds(row.created_at),
        ...(row.expires_at ? { expiresAt: seconds(row.expires_at) } : {}),
        auto,
        ...(script ? { script } : {}),
      };
      if (auto) {
        await systemLine(database, {
          roomId: input.roomId,
          subject: { kind: 'agent', id: agentId, name: agent.name },
          verb: 'was granted',
          object: `${kind} ${target}`,
          consequence: autoGrantConsequence(kind, surfaceForRoom(context.parent_id !== null)),
          cardType: 'grant-auto',
          card: { grantId },
        });
        return { messageId: undefined };
      }
      if (squireRoute) {
        const ownerMember = await database.query(
          `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
           AND identity_id=$2 AND removed_at IS NULL`,
          [context.workspace_id, context.owner_id],
        );
        if (!ownerMember.rowCount) throw new Error('Squire owner is no longer a workspace member');
        const dmRoomId = await ensureConnectorDirectMessageRoom(
          database,
          context.workspace_id,
          'trusty-squire',
          context.owner_id,
        );
        const messageId = id();
        await systemLine(database, {
          id: messageId,
          roomId: dmRoomId,
          authorId: connectorIdentityId('trusty-squire'),
          ...grantCardPhrase(agent, owner, [grantView]),
          presentation: 'card',
          cardType: 'grant-request',
          card: {
            agent,
            owner,
            requester,
            grants: [grantView],
            sourceRoomId: input.roomId,
            ...(sourceMessageId ? { sourceMessageId } : {}),
          },
        });
        return { messageId, cardRoomId: dmRoomId };
      }
      // Several asks in one turn become one card: join this agent's open card
      // in the Room while every grant on it is still pending and it is recent.
      const open = (
        await database.query<{ id: string; card: { grants: unknown[] } }>(
          `SELECT m.id,m.card FROM messages m
           WHERE m.room_id=$1 AND m.author_id=$2 AND m.card_type='grant-request'
             AND m.created_at>now()-interval '2 minutes'
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(m.card->'grants') entry
               JOIN agent_grants pending_grant ON pending_grant.id=(entry->>'grantId')::uuid
               WHERE pending_grant.status<>'pending'
             )
           ORDER BY m.created_at DESC,m.id DESC LIMIT 1
           FOR UPDATE`,
          [input.roomId, agentId],
        )
      ).rows[0];
      if (open) {
        const grants = [...(open.card.grants ?? []), grantView] as (typeof grantView)[];
        await restateSystemLine(database, open.id, grantCardPhrase(agent, owner, grants), {
          agent,
          owner,
          requester,
          grants,
        });
        return { messageId: open.id };
      }
      const messageId = id();
      await systemLine(database, {
        id: messageId,
        roomId: input.roomId,
        ...grantCardPhrase(agent, owner, [grantView]),
        // The owner is reached by the card itself in the Room — a card is
        // outside `background.ts`'s push ceiling — not by a wake: this line
        // has no kind, so it starts no turn and never did.
        presentation: 'card',
        cardType: 'grant-request',
        card: { agent, owner, requester, grants: [grantView] },
      });
      return { messageId };
    });
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'grant', agentId });
    if (result.cardRoomId)
      this.live.publish({ type: 'invalidate', roomId: result.cardRoomId, reason: 'grant' });
    return {
      grantId,
      status,
      auto,
      ...(result.messageId ? { messageId: result.messageId } : {}),
      ...(escalations.length ? { escalations } : {}),
    };
  }

  private async askRoomChoice(input: Input<'askRoomChoice'>, agentId: string) {
    const posted = await this.writeRoomChoice({
      roomId: input.roomId,
      agentId,
      mode: 'question',
      prompt: input.prompt,
      constraint: input.constraint,
      options: input.options,
      ttlSeconds: input.ttlSeconds,
    });
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'choice', agentId });
    return posted;
  }

  private async openRoomPoll(input: Input<'openRoomPoll'>, agentId: string) {
    const posted = await this.writeRoomChoice({
      roomId: input.roomId,
      agentId,
      mode: 'poll',
      prompt: input.prompt,
      constraint: input.constraint,
      options: input.options,
      ttlSeconds: input.ttlSeconds,
    });
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'choice', agentId });
    return posted;
  }

  private async writeRoomChoice(
    input: Parameters<typeof postRoomChoice>[1],
  ): Promise<Awaited<ReturnType<typeof postRoomChoice>>> {
    if (this.commandTransaction) return postRoomChoice(this.database, input);
    return this.database.transaction((database) => postRoomChoice(database, input));
  }

  /** Every live rule for this agent: approved or once, unexpired, not revoked. */
  private async listAgentGrants(agentId: string, roomId?: string) {
    const rows = await this.database.query<{
      id: string;
      workspace_id: string;
      room_id: string;
      kind: AgentGrantKind;
      target: string;
      status: 'approved' | 'once';
      requested_by: string;
      requester_name: string | null;
      expires_at: Date | null;
      script: CommandGrantScript | null;
    }>(
      `SELECT g.id,g.workspace_id,g.room_id,g.kind,g.target,g.status,g.requested_by,
              requester.name requester_name,g.expires_at,g.script
       FROM agent_grants g LEFT JOIN identities requester ON requester.id=g.requested_by
       WHERE g.agent_id=$1 AND g.status IN ('approved','once')
         AND (g.expires_at IS NULL OR g.expires_at>now())
         AND ($2::uuid IS NULL OR g.workspace_id=(SELECT workspace_id FROM rooms WHERE id=$2))
       ORDER BY g.created_at DESC,g.id`,
      [agentId, roomId ?? null],
    );
    return {
      grants: rows.rows.map((row) => ({
        grantId: row.id,
        workspaceId: row.workspace_id,
        roomId: row.room_id,
        kind: row.kind,
        target: row.target,
        status: row.status,
        requestedBy: row.requested_by,
        ...(row.requester_name ? { requestedByName: row.requester_name } : {}),
        ...(row.expires_at ? { expiresAt: seconds(row.expires_at) } : {}),
        ...(isCommandGrantScript(row.script) ? { script: row.script } : {}),
      })),
    };
  }
  /** A 'once' grant is spent by its first run: it stops matching immediately. */
  private async consumeAgentGrant(input: Input<'consumeAgentGrant'>, agentId: string) {
    if (typeof input.grantId !== 'string' || !input.grantId) throw new Error('grantId is required');
    const spent = await this.database.query(
      `UPDATE agent_grants SET expires_at=now()
       WHERE id::text=$1 AND agent_id=$2 AND status='once' AND (expires_at IS NULL OR expires_at>now())`,
      [input.grantId, agentId],
    );
    if (!spent.rowCount) throw new Error('once grant not found');
    return this.writeResult();
  }

  /**
   * Squire is mounted per session, not per speaker. Each call still checks who
   * triggered the turn: the owner passes; anyone else needs a live mcp/squire
   * grant keyed to them. A miss posts the existing Once/Always/No card in the
   * owner's Trusty Squire DM.
   */
  private async authorizeSquireCall(input: Input<'authorizeSquireCall'>, agentId: string) {
    await this.access(input.roomId, agentId);
    const context = (
      await this.database.query<{
        workspace_id: string;
        owner_id: string;
      }>(
        `SELECT room.workspace_id,a.owner_id
         FROM rooms room
         JOIN agents a ON a.agent_id=$2
         WHERE room.id=$1`,
        [input.roomId, agentId],
      )
    ).rows[0];
    if (!context) throw new Error('agent not found');
    const sourceMessageId = this.authorizedCommand?.source_message_id;
    const requesterRow = (
      await this.database.query<{ id: string }>(
        `SELECT identity.id
         FROM agent_commands command
         JOIN messages message ON message.id=command.source_message_id
         JOIN identities identity ON identity.id=message.author_id
         WHERE command.room_id=$1 AND command.agent_id=$2 AND message.author_id<>$2
           AND message.presentation<>'activity'
           AND ($3::text IS NULL OR command.source_message_id=$3)
         ORDER BY command.created_at DESC,command.id DESC LIMIT 1`,
        [input.roomId, agentId, sourceMessageId ?? null],
      )
    ).rows[0];
    const requesterId = requesterRow?.id ?? context.owner_id;
    const listed = await this.listAgentGrants(agentId, input.roomId);
    const verdict = squireCallAllowed({
      requesterId,
      ownerId: context.owner_id,
      grants: listed.grants,
    });
    if (verdict.allowed) {
      if (verdict.consume && verdict.grantId)
        await this.consumeAgentGrant({ grantId: verdict.grantId }, agentId);
      return {
        allowed: true as const,
        ...(verdict.grantId ? { grantId: verdict.grantId } : {}),
      };
    }
    const pending = (
      await this.database.query<{ id: string }>(
        `SELECT id FROM agent_grants
         WHERE agent_id=$1 AND workspace_id=$2 AND kind='mcp' AND target='squire'
           AND requested_by=$3 AND status='pending'
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [agentId, context.workspace_id, requesterId],
      )
    ).rows[0];
    if (pending) {
      const card = (
        await this.database.query<{ id: string }>(
          `SELECT id FROM messages
           WHERE card_type='grant-request'
             AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(card->'grants') entry
               WHERE entry->>'grantId'=$1
             )
           ORDER BY created_at DESC,id DESC LIMIT 1`,
          [pending.id],
        )
      ).rows[0];
      return {
        allowed: false as const,
        grantId: pending.id,
        status: 'pending' as const,
        ...(card ? { messageId: card.id } : {}),
      };
    }
    const asked = await this.requestAgentGrant(
      {
        roomId: input.roomId,
        kind: 'mcp',
        target: 'squire',
        reason: 'use Trusty Squire on this turn',
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.generationId ? { generationId: input.generationId } : {}),
      },
      agentId,
    );
    return {
      allowed: false as const,
      grantId: asked.grantId,
      status: asked.status,
      ...(asked.messageId ? { messageId: asked.messageId } : {}),
    };
  }

  // --- R5: connector offers -------------------------------------------------

  /**
   * The Room, this agent's machine, and the person this turn answers. The
   * ADDRESSEE is the human whose message woke the agent — whose keys an added
   * tool will hold — read from the command that woke it (the command IS the
   * trigger, so a scheduled or subscription wake resolves too). An agent-woken
   * turn addresses nobody human; the offering agent's owner stands in.
   */
  private async offerContext(roomId: string, agentId: string) {
    const context = (
      await this.database.query<{
        workspace_id: string;
        parent_id: string | null;
        owner_id: string;
        machine_id: string | null;
        machine_name: string | null;
        agent_name: string;
        agent_handle: string | null;
        agent_avatar: string | null;
        owner_name: string;
        owner_handle: string | null;
        owner_avatar: string | null;
      }>(
        `SELECT room.workspace_id,room.parent_id,a.owner_id,a.machine_id,a.machine_name,
                agent.name agent_name,agent.handle agent_handle,agent.avatar agent_avatar,
                owner.name owner_name,owner.handle owner_handle,owner.avatar owner_avatar
         FROM rooms room
         JOIN agents a ON a.agent_id=$2
         JOIN identities agent ON agent.id=a.agent_id
         JOIN identities owner ON owner.id=a.owner_id
         WHERE room.id=$1`,
        [roomId, agentId],
      )
    ).rows[0];
    if (!context) throw new Error('agent not found');
    const woke = this.authorizedCommand?.source_message_id
      ? await this.database.query<{
          id: string;
          name: string;
          handle: string | null;
          avatar: string | null;
        }>(
          `SELECT identity.id,identity.name,identity.handle,identity.avatar
           FROM messages message JOIN identities identity ON identity.id=message.author_id
           WHERE message.id=$1 AND identity.kind='human' AND identity.hidden_from_roster=false`,
          [this.authorizedCommand.source_message_id],
        )
      : await this.database.query<{
          id: string;
          name: string;
          handle: string | null;
          avatar: string | null;
        }>(
          `SELECT identity.id,identity.name,identity.handle,identity.avatar
           FROM agent_commands command
           JOIN messages message ON message.id=command.source_message_id
           JOIN identities identity ON identity.id=message.author_id
           WHERE command.room_id=$1 AND command.agent_id=$2
             AND identity.kind='human' AND identity.hidden_from_roster=false
           ORDER BY command.created_at DESC,command.id DESC LIMIT 1`,
          [roomId, agentId],
        );
    const addresseeRow = woke.rows[0];
    const addressee = addresseeRow
      ? {
          pubkey: addresseeRow.id,
          kind: 'human' as const,
          name: addresseeRow.name,
          ...(addresseeRow.handle ? { handle: addresseeRow.handle } : {}),
          ...(addresseeRow.avatar ? { avatar: addresseeRow.avatar } : {}),
        }
      : {
          pubkey: context.owner_id,
          kind: 'human' as const,
          name: context.owner_name,
          ...(context.owner_handle ? { handle: context.owner_handle } : {}),
          ...(context.owner_avatar ? { avatar: context.owner_avatar } : {}),
        };
    const agent = {
      pubkey: agentId,
      kind: 'agent' as const,
      name: context.agent_name,
      ...(context.agent_handle ? { handle: context.agent_handle } : {}),
      ...(context.agent_avatar ? { avatar: context.agent_avatar } : {}),
    };
    // A legacy daemon that never reported a machine IS its own machine, the
    // same identity `pairConnector` resolves for it.
    const machine = {
      machineId: context.machine_id ?? agentId,
      name: context.machine_name ?? context.agent_name,
    };
    return {
      workspaceId: context.workspace_id,
      isCorner: context.parent_id !== null,
      addressee,
      agent,
      machine,
    };
  }

  /**
   * workbench_status: what the Workbench can add, and what the person this
   * turn answers already has. Names only — a connection is listed by service
   * and label, never by anything the vault holds.
   */
  private async agentWorkbench(
    input: Input<'readAgentWorkbench'>,
    agentId: string,
  ): Promise<Output<'readAgentWorkbench'>> {
    if (typeof input.roomId !== 'string' || !input.roomId) throw new Error('roomId is required');
    const context = await this.offerContext(input.roomId, agentId);
    const paired = (
      await this.database.query<{
        connector_type: string;
        status: 'installing' | 'connected' | 'error' | 'disconnected';
        machine_id: string | null;
        helper_agent_id: string;
        helper_name: string;
        updated_at: Date;
      }>(
        `SELECT k.connector_type,k.status,k.machine_id,k.helper_agent_id,
                COALESCE(NULLIF(a.machine_name,''),helper.name) helper_name,k.updated_at
         FROM workspace_connectors k
         JOIN identities helper ON helper.id=k.helper_agent_id
         LEFT JOIN agents a ON a.agent_id=k.helper_agent_id
         WHERE k.workspace_id=$1 AND k.owner_identity_id=$2
         ORDER BY k.updated_at DESC`,
        [context.workspaceId, context.addressee.pubkey],
      )
    ).rows;
    const catalog = connectorCatalog().map((entry) => {
      // The most recently touched row wins; a live one over a disconnected one.
      const rows = paired.filter((row) => row.connector_type === entry.connectorType);
      const row = rows.find((candidate) => candidate.status !== 'disconnected') ?? rows[0];
      return {
        connectorType: entry.connectorType,
        name: entry.name,
        purpose: connectorPurpose(entry.connectorType),
        available:
          entry.available &&
          (!entry.connectorType.startsWith('google-') || Boolean(this.googleOAuth)),
        offerable:
          entry.available &&
          (!entry.connectorType.startsWith('google-') || Boolean(this.googleOAuth)) &&
          !context.isCorner &&
          isOfferableConnectorKind(entry.connectorType),
        ...(row
          ? {
              paired: {
                status: row.status,
                helperName: row.helper_name,
                onThisMachine:
                  (row.machine_id ?? row.helper_agent_id) === context.machine.machineId,
              },
            }
          : {}),
      };
    });
    const connections = (
      await this.database.query<{
        connector_type: string;
        service: string | null;
        label: string | null;
        reference: string;
        state: 'active' | 'error';
      }>(
        `SELECT k.connector_type,NULLIF(c.service,'') service,c.label,c.reference,c.state
         FROM workspace_connections c
         JOIN workspace_connectors k ON k.id=c.connector_id
         WHERE c.owner_identity_id=$1 AND k.workspace_id=$2
         ORDER BY c.service,c.reference`,
        [context.addressee.pubkey, context.workspaceId],
      )
    ).rows;
    return {
      addressee: {
        identityId: context.addressee.pubkey,
        name: context.addressee.name,
        ...(context.addressee.handle ? { handle: context.addressee.handle } : {}),
      },
      catalog,
      connections: connections.map((row) => ({
        connectorType: row.connector_type,
        service: row.service,
        label: row.label ?? row.reference,
        state: row.state,
      })),
      machine: context.machine,
    };
  }

  /**
   * offer_connector: ONE card in the Room, spoken by the agent, addressed to
   * the person whose keys the tool will hold. The turn pauses on it the way a
   * grant ask pauses (the card's accept resumes it through the hidden
   * `connector-offer-decided` line). A repeat of the same offer inside the
   * window joins the open card rather than posting a second; a tool the
   * addressee already has, or that ANOTHER agent already offered here, is a
   * refusal the agent can restate — a second agent could never be woken by
   * the first agent's card, so it must not wait on it.
   */
  private async offerConnector(
    input: Input<'offerConnector'>,
    agentId: string,
  ): Promise<Output<'offerConnector'>> {
    if (typeof input.roomId !== 'string' || !input.roomId) throw new Error('roomId is required');
    if (!isOfferableConnectorKind(input.connectorType))
      throw new Error(
        `connector type is invalid: ${String(input.connectorType)} cannot be offered from a Room`,
      );
    if (typeof input.reason !== 'string' || !input.reason.trim())
      throw new Error('offer reason is required');
    const reason = input.reason.trim().replace(/\s+/g, ' ');
    if (reason.length > CONNECTOR_OFFER_REASON_MAX_LENGTH)
      throw new Error('offer reason is invalid: too long');
    const connectorType: ConnectorKind = input.connectorType;
    const context = await this.offerContext(input.roomId, agentId);
    if (context.isCorner)
      throw new Error('connector offer is invalid: offer a tool from the Room, not from a corner');
    const connectorName = connectorDisplayName(connectorType);
    const already = (
      await this.database.query<{ status: string }>(
        `SELECT status FROM workspace_connectors
         WHERE workspace_id=$1 AND owner_identity_id=$2 AND connector_type=$3
           AND status IN ('installing','connected')
         ORDER BY updated_at DESC LIMIT 1`,
        [context.workspaceId, context.addressee.pubkey, connectorType],
      )
    ).rows[0];
    if (already)
      throw new Error(
        `connector offer conflict: ${context.addressee.name} already has ${connectorName} (${already.status}); check workbench_status`,
      );
    const result = await this.database.transaction(async (database) => {
      // One open offer per Room+connector, even when two agents race: lock
      // first, then read any pending row (age does not create a second card).
      await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `connector-offer:${input.roomId}:${connectorType}`,
      ]);
      const open = (
        await database.query<{ id: string; agent_id: string; message_id: string | null }>(
          `SELECT id,agent_id,message_id FROM connector_offers
           WHERE room_id=$1 AND connector_type=$2 AND status='pending'
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [input.roomId, connectorType],
        )
      ).rows[0];
      if (open && open.agent_id === agentId && open.message_id)
        return { offerId: open.id, messageId: open.message_id, joined: true };
      if (open && open.agent_id !== agentId) {
        const other = (
          await database.query<{ name: string }>(`SELECT name FROM identities WHERE id=$1`, [
            open.agent_id,
          ])
        ).rows[0];
        throw new Error(
          `connector offer conflict: ${other?.name ?? 'another agent'} already offered ${connectorName} here; let that card be answered`,
        );
      }
      const offerId = randomUUID();
      const messageId = id();
      const created = (
        await database.query<{ created_at: Date }>(
          `INSERT INTO connector_offers(
             id,agent_id,workspace_id,room_id,addressee_id,connector_type,reason,machine_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`,
          [
            offerId,
            agentId,
            context.workspaceId,
            input.roomId,
            context.addressee.pubkey,
            connectorType,
            reason,
            context.machine.machineId,
          ],
        )
      ).rows[0]!;
      const card: ConnectorOfferCardView = {
        offerId,
        agent: context.agent,
        addressee: context.addressee,
        connectorType,
        connectorName,
        reason,
        consequence: connectorOfferConsequence(connectorType, reason),
        helper: context.machine,
        status: 'pending',
        createdAt: seconds(created.created_at),
      };
      // The addressee is reached by the card itself in the Room — a card is
      // outside `background.ts`'s push ceiling — not by a wake: this line has
      // no kind, so it starts no turn.
      await systemLine(database, {
        id: messageId,
        roomId: input.roomId,
        subject: { kind: 'agent', id: agentId, name: context.agent.name },
        verb: `offered ${systemIdentityMention({
          id: context.addressee.pubkey,
          kind: 'human',
          name: context.addressee.name,
          handle: context.addressee.handle ?? null,
        })}`,
        object: connectorName,
        consequence: reason,
        presentation: 'card',
        cardType: 'connector-offer',
        card: card as unknown as Record<string, unknown>,
      });
      await database.query(`UPDATE connector_offers SET message_id=$2 WHERE id=$1`, [
        offerId,
        messageId,
      ]);
      return { offerId, messageId, joined: false };
    });
    this.live.publish({
      type: 'invalidate',
      roomId: input.roomId,
      reason: 'connector-offer',
      agentId,
    });
    return {
      offerId: result.offerId,
      status: 'pending',
      messageId: result.messageId,
      joined: result.joined,
    };
  }

  private async createCorner(input: Input<'createCorner'>, agentId: string) {
    // Untidy is not wrong: a brief handed over with line breaks or double
    // spaces is flattened here, and only a genuinely over-long text is
    // refused — in a sentence that names the limit and the count (C90).
    const objective = normalizeCornerText(input.objective ?? '');
    const name = normalizeCornerText(input.name ?? '');
    const refusal =
      cornerTextRefusal('name', input.name) ?? cornerTextRefusal('objective', input.objective);
    if (refusal) throw new Error(refusal);
    const idempotencyKey = input.idempotencyKey ?? input.requestId;
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new Error('invalid corner idempotency key');
    }
    await this.access(input.roomId, agentId);
    const parent = (
      await this.database.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM rooms WHERE id=$1`,
        [input.roomId],
      )
    ).rows[0]!;
    let cornerId: string = randomUUID();
    const opener = await this.identity(agentId);
    await this.database.transaction(async (db) => {
      // Opening a corner is idempotent for one confirmed tool call while that
      // corner remains active. Locking the parent closes the read/insert race:
      // a concurrent retry waits, sees the winner, and returns its id without
      // creating another Room, command, or open card.
      await db.query(`SELECT id FROM rooms WHERE id=$1 FOR UPDATE`, [input.roomId]);
      const existing = (
        await db.query<{ corner_id: string }>(
          `SELECT child.id::text corner_id
           FROM rooms child
           JOIN corner_facts fact ON fact.corner_id=child.id
           WHERE child.parent_id=$1
             AND COALESCE(fact.open_idempotency_key,fact.request_id)=$2
             AND child.archived_at IS NULL
           ORDER BY child.created_at,child.id
           LIMIT 1`,
          [input.roomId, idempotencyKey],
        )
      ).rows[0];
      if (existing) {
        cornerId = existing.corner_id;
        return;
      }
      const parentCommand = await authorizeCommandOutput(
        db,
        input.roomId,
        agentId,
        input.requestId,
        input.generationId,
      );
      const commissionedBy = (
        await db.query<{ author_id: string }>(
          `SELECT message.author_id FROM messages message
           JOIN identities requester ON requester.id=message.author_id AND requester.kind='human'
           WHERE message.id=$1`,
          [parentCommand.root_source_message_id],
        )
      ).rows[0]?.author_id;
      await db.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,repository_key,repository_target_branch) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          cornerId,
          parent.workspace_id,
          input.roomId,
          agentId,
          name,
          input.repository ?? null,
          input.targetBranch ?? 'main',
        ],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role,event_subscriptions)
         SELECT workspace_id,$2,identity_id,role,event_subscriptions FROM memberships
         WHERE room_id=$1 AND removed_at IS NULL ON CONFLICT DO NOTHING`,
        [input.roomId, cornerId],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')
         ON CONFLICT(room_id,identity_id) WHERE room_id IS NOT NULL
         DO UPDATE SET role='owner',removed_at=NULL`,
        [parent.workspace_id, cornerId, agentId],
      );
      // A corner with no repository has nothing to commit, so it is the no-code
      // lane however the caller asked. Recording anything else would tell a
      // later reader of `corner_facts` that a pull request was possible here.
      const lane = input.repository ? (input.lane ?? 'code') : 'no_code';
      await db.query(
        `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,objective,request_id,open_idempotency_key,lane,lifecycle)
         VALUES($1,$2,$3,$4,$5,$6,$7,'{"lifecycle":"working","checks":"unknown"}')`,
        [
          cornerId,
          agentId,
          commissionedBy ?? null,
          objective,
          input.requestId,
          idempotencyKey,
          lane,
        ],
      );
      // The objective is the OPENER's work. Every other agent is copied in as a
      // member so it can read the corner and answer when tagged, but it gets no
      // intake command: #1206 fanned the objective out to every agent member and
      // every agent in the workspace started working the same corner at once
      // (captain report 2026-09-14 02:4xZ, corner "Workspace Rail Labels").
      await createAgentCommand(db, {
        roomId: cornerId,
        agentId,
        sourceMessageId: parentCommand.source_message_id,
        reason: 'corner_objective',
        parent: parentCommand,
        retainDepth: true,
        turnRequestId: input.requestId,
      });
      // One durable open marker in the parent Room; the phone renders this as
      // a daemon-fact card. Corner lifecycle is outside the push ceiling
      // (`background.ts`), so this marker never notifies a device.
      await systemLine(db, {
        roomId: input.roomId,
        subject: { kind: 'agent', id: agentId, name: opener.name },
        verb: 'opened a corner',
        kind: 'corner-opened',
        // The NAME titles the corner everywhere; the objective is the card body.
        object: { text: name, id: cornerId },
        presentation: 'card',
        cardType: 'daemon-fact',
        card: { type: 'corner-open', cornerId, name, objective },
      });
    });
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'corner', agentId });
    return { cornerId };
  }
  private async archiveCorner(cornerId: string, agentId: string) {
    const parentId = await this.database.transaction(async (database) => {
      const fact = await database.query<{ lane: string }>(
        `SELECT lane FROM corner_facts WHERE corner_id=$1 FOR UPDATE`,
        [cornerId],
      );
      if (fact.rows[0]?.lane === 'research')
        throw new Error('research corners require a human to close them');
      return (await closeCornerState(database, cornerId)).parentId;
    });
    this.live.publish({ type: 'invalidate', roomId: cornerId, reason: 'corner', agentId });
    this.live.publish({ type: 'invalidate', roomId: parentId, reason: 'corner', agentId });
    return this.writeResult();
  }
  private async ensureMembership(input: Input<'ensureAgentMembership'>, agentId: string) {
    const room = (
      await this.database.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM rooms WHERE id=$1`,
        [input.roomId],
      )
    ).rows[0];
    if (!room) throw new Error('room not found');
    const workspaceMember = await this.database.query(
      `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL`,
      [room.workspace_id, agentId],
    );
    if (!workspaceMember.rowCount) throw new Error('daemon workspace access denied');
    await this.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`,
      [room.workspace_id, input.roomId, agentId],
    );
    return this.writeResult();
  }
  private async identity(agentId: string) {
    const row = (
      await this.database.query<{ name: string }>(`SELECT name FROM identities WHERE id=$1`, [
        agentId,
      ])
    ).rows[0];
    return {
      pubkey: agentId,
      kind: 'agent' as const,
      name: row?.name ?? `Agent ${agentId.slice(0, 8)}`,
    };
  }
  /**
   * Resolves on the corner's next live event the intake loop can act on
   * (`wakesCorner`), or after the bounded timeout with nothing new — the
   * daemon's poll is unaffected either way, so a missed or timed-out wake
   * never loses an event; the next poll still catches it.
   *
   * Two consecutive wakes of one corner are held at least
   * `CORNER_WAKE_MIN_INTERVAL_MS` apart, so a burst of qualifying events costs
   * one poll for the whole burst instead of one poll each.
   */
  private async waitForCornerWake(cornerId: string, agentId: string): Promise<{ woken: boolean }> {
    const horizon = Date.now() - CORNER_WAKE_TIMEOUT_MS;
    for (const [corner, at] of this.lastCornerWake)
      if (at < horizon) this.lastCornerWake.delete(corner);
    return new Promise((resolvePromise) => {
      let unsubscribe: (() => void) | undefined;
      const timer = setTimeout(() => {
        unsubscribe?.();
        resolvePromise({ woken: false });
      }, CORNER_WAKE_TIMEOUT_MS);
      const wake = () => {
        this.lastCornerWake.set(cornerId, Date.now());
        resolvePromise({ woken: true });
      };
      unsubscribe = this.live.subscribe(cornerId, (event) => {
        if (!wakesCorner(event, agentId)) return;
        clearTimeout(timer);
        unsubscribe?.();
        const since = Date.now() - (this.lastCornerWake.get(cornerId) ?? 0);
        if (since >= CORNER_WAKE_MIN_INTERVAL_MS) wake();
        else setTimeout(wake, CORNER_WAKE_MIN_INTERVAL_MS - since);
      });
    });
  }
  /**
   * Membership, plus the one thing the caller would otherwise need a second
   * round trip to learn: whether this agent is the configured reviewer of the
   * corner it is writing into. Only such an agent can be ending a review, so
   * the review handoff asks its own question only for them, and an ordinary
   * Room reply — the hottest write in the product — pays nothing for it.
   */
  private async access(
    roomId: string,
    agentId: string,
  ): Promise<{ cornerReviewer: boolean; isCorner: boolean }> {
    const result = await this.database.query<{ corner_reviewer: boolean; is_corner: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM rooms corner JOIN rooms parent ON parent.id=corner.parent_id
         WHERE corner.id=$1 AND parent.reviewer_agent_id=$2
       ) corner_reviewer,
       EXISTS(SELECT 1 FROM rooms corner WHERE corner.id=$1 AND corner.parent_id IS NOT NULL) is_corner
       FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
      [roomId, agentId],
    );
    if (!result.rowCount) throw new Error('daemon room access denied');
    return { cornerReviewer: result.rows[0]!.corner_reviewer, isCorner: result.rows[0]!.is_corner };
  }

  /** Adds one fixed-vocabulary reaction without turning a retried tool call into an unreact. */
  private async reactToRoomMessage(
    input: Input<'reactToRoomMessage'>,
    agentId: string,
  ): Promise<Output<'reactToRoomMessage'>> {
    if (!MESSAGE_REACTION_EMOJIS.includes(input.emoji)) throw new Error('reaction is invalid');
    await this.database.transaction(async (database) => {
      const row = (
        await database.query<{ reactions: Record<string, string[]> }>(
          `SELECT reactions FROM messages
           WHERE id=$1 AND room_id=$2 AND presentation='message'
           FOR UPDATE`,
          [input.messageId, input.roomId],
        )
      ).rows[0];
      if (!row) throw new Error('message is not available for reaction');
      const reactions = { ...(row.reactions ?? {}) };
      const reactors = new Set(reactions[input.emoji] ?? []);
      reactors.add(agentId);
      reactions[input.emoji] = [...reactors];
      await database.query(`UPDATE messages SET reactions=$3::jsonb WHERE id=$1 AND room_id=$2`, [
        input.messageId,
        input.roomId,
        JSON.stringify(reactions),
      ]);
    });
    this.live.publish({
      type: 'invalidate',
      roomId: input.roomId,
      reason: 'message',
      messageId: input.messageId,
      agentId,
    });
    return this.writeResult();
  }
  /**
   * The one operation a corner still reserves for the agent that opened it.
   *
   * Every other corner write is membership-gated by `access` above, because a
   * corner works like a Room: whoever is addressed carries the branch on, and
   * the PR/checks lifecycle facts belong to the CORNER, not to one agent.
   * Archiving is the exception because it is terminal for the shared artifact
   * — it stops every member's loop and reaps their worktrees — so a helper
   * pulled in for one question cannot close someone else's work. It is not a
   * dead end when the opener is gone: the merge webhook archives on landing,
   * and a human can still request the close.
   */
  private async assertCornerOpener(roomId: string, agentId: string) {
    const corner = await this.database.query<{ owner_agent_id: string | null }>(
      `SELECT fact.owner_agent_id
       FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id
       WHERE room.id=$1 AND room.parent_id IS NOT NULL`,
      [roomId],
    );
    const opener = corner.rows[0]?.owner_agent_id;
    if (corner.rowCount && opener !== agentId) throw new Error('daemon corner access denied');
  }
  private writeResult(extra?: { hiccupRestart?: boolean; hiccupAttempt?: number }) {
    return { id: id(), createdAt: Math.floor(Date.now() / 1000), ...extra };
  }
}

/**
 * What a yolo auto-approval actually licensed, so a scroll-back reads as an
 * account of what happened and not a list of names (C94). The boundary is the
 * capability table's, exact and enforced by the mount namespace the runner
 * spawns into: a Room reads, a corner writes its worktree and acts on the host.
 */
function autoGrantConsequence(kind: AgentGrantKind, surface: AgentSurface): string {
  if (kind !== 'command') return 'auto-approved under yolo';
  return `auto-approved under yolo, ${surfaceGrantBoundary(surface)}`;
}

/**
 * The script bytes the daemon read for an interpreter command, checked against
 * the line they claim to belong to. The server never reads the operator's
 * filesystem, so this validates the daemon's reading rather than repeating it;
 * the runner re-hashes the file before every run.
 */
function validateGrantScript(
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

/** The push/preview text of a grant card: who asks whom for what, and why. */
/** The grant card's header sentence: `Bee asked Owner for command npm test · run the tests`. */
function grantCardPhrase(
  agent: { pubkey: string; name: string },
  owner: { pubkey: string; kind: 'human'; name: string; handle?: string },
  grants: readonly { kind: AgentGrantKind; target: string; reason: string }[],
): SystemPhrase {
  return {
    subject: { kind: 'agent', id: agent.pubkey, name: agent.name },
    verb: `asked ${systemIdentityMention({
      id: owner.pubkey,
      kind: owner.kind,
      name: owner.name,
      handle: owner.handle ?? null,
    })} for`,
    object: grants.map((grant) => `${grant.kind} ${grant.target}`).join(' and '),
    ...(grants.length === 1 && grants[0]!.reason ? { consequence: grants[0]!.reason } : {}),
  };
}

/** The one projection an inbox or conversation row is read through. */
const conversationColumns = `SELECT id,author_id,created_at,presentation,text,card->>'askId' corner_ask_id,
        EXISTS(SELECT 1 FROM identities author
               WHERE author.id=messages.author_id AND author.kind='agent') agent_author,
        reply_to_message_id,
        (SELECT parent.author_id FROM messages parent WHERE parent.id=messages.reply_to_message_id) reply_to_author_id,
        root_message_id,request_id,
        (SELECT request.author_id FROM messages request WHERE request.id=messages.request_id) request_author_id,
        agent_hop_count,attachments,system_event,
        ${MESSAGE_CURSOR_MS_SQL} cursor_ms,
        floor(extract(epoch FROM now())*1000)::bigint now_ms`;

function laterCursor(
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
const DAEMON_OPERATION_ROUTES: Record<keyof DaemonOperationMap, true> = {
  getDaemonBootstrap: true,
  getWorkspaceRoster: true,
  getRoomInbox: true,
  getRoomConversation: true,
  getCornerAsk: true,
  getRoomAuthority: true,
  getPermissionAuthority: true,
  getMissionAuthority: true,
  listWorkSchedules: true,
  getWorkScheduleAuthority: true,
  listAgentToolSchedules: true,
  createAgentSchedule: true,
  setEventSubscriptions: true,
  listEventSubscriptions: true,
  postRoomEvent: true,
  listAgentSchedules: true,
  deleteAgentSchedule: true,
  getAgentToolMandate: true,
  getTargetAgentAuthority: true,
  listRoomCorners: true,
  getCornerRestoreState: true,
  getPrChecksStatus: true,
  approveCornerMerge: true,
  getCornerCloseRequests: true,
  waitForCornerWake: true,
  listUntrackedCorners: true,
  getRoomRepositoryState: true,
  getRoomGitHubToken: true,
  getRoomTargetBranch: true,
  getIdentitySuccession: true,
  getAgentConfiguration: true,
  getAgentPresence: true,
  getRequestCompletion: true,
  getAgentCommands: true,
  claimAgentCommand: true,
  acknowledgeAgentCommand: true,
  postRoomMessage: true,
  reactToRoomMessage: true,
  postAgentAttachment: true,
  postAgentDraft: true,
  postAgentThought: true,
  retractAgentLiveOutput: true,
  postAgentTurnReceipt: true,
  postAgentActivity: true,
  postPermissionRequest: true,
  postPermissionExecution: true,
  postWorkSchedule: true,
  postWorkScheduleReceipt: true,
  postAgentToolScheduleIndex: true,
  postAgentToolMandate: true,
  postAgentCommands: true,
  postAgentModelCatalog: true,
  postAgentMachineReport: true,
  getConnectorAssignments: true,
  getGoogleOAuthGrant: true,
  installConnector: true,
  postConnectorStatus: true,
  postConnectorVault: true,
  getConnectorStatus: true,
  getConnectorVaultList: true,
  getConnectionDetail: true,
  revokeConnectionGrants: true,
  postConnectionUsage: true,
  postCornerLifecycle: true,
  postCornerRemoteState: true,
  postCornerPlan: true,
  putCornerApp: true,
  requestCornerAppOpen: true,
  postTargetBranchProposal: true,
  requestAgentGrant: true,
  askRoomChoice: true,
  openRoomPoll: true,
  listAgentGrants: true,
  consumeAgentGrant: true,
  authorizeSquireCall: true,
  readAgentWorkbench: true,
  offerConnector: true,
  createCorner: true,
  archiveCorner: true,
  ensureAgentMembership: true,
  getWalletToolState: true,
  getWalletToolBalance: true,
  getWalletToolChains: true,
  getWalletToolHistory: true,
  getWalletToolQuote: true,
  walletPay: true,
  walletSwap: true,
};
export const DAEMON_OPERATION_NAMES = new Set(
  Object.keys(DAEMON_OPERATION_ROUTES) as (keyof DaemonOperationMap)[],
);
