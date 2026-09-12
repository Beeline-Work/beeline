import {
  authorizeCommandOutput,
  claimAgentCommand,
  commandInbox,
  createAgentCommand,
  readAgentCommands,
  routeAgentResult,
  type CommandRow,
} from './agent-command.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  DaemonAttachment,
  DaemonOperationMap,
  SystemEvent,
} from '@beeline/api-contract/daemon';
import {
  AGENT_TO_AGENT_HOP_CAP,
  cornerTextRefusal,
  normalizeCornerText,
} from '@beeline/api-contract/daemon';
import {
  MAX_EVENT_CONSEQUENCE_LENGTH,
  MAX_MENTIONS_PER_EVENT,
  SERVER_EVENT_KINDS,
  isAgentKind,
  isServerEventKind,
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
import {
  AGENT_REACHABLE_HORIZON_MS,
  parseAgentAccessPolicy,
  senderMayAddressAgent,
} from '@beeline/api-contract/agent-access';
import { resolveCurrentMemberMentions, typedMentionHandles } from './message-mentions.js';

type Input<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['input'];
type Output<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['output'];
const id = () => randomBytes(32).toString('hex');

/** Server-side cap on the daemon's distilled failure reason (matches the daemon's own cap). */
const TURN_FAILURE_REASON_MAX = 200;
export const INBOX_REPLAY_REWIND_MS = 5_000;

/** A durable success after a failed line settles that line in place. */
async function settleTurnFailureLine(
  database: SqlDatabase,
  roomId: string,
  requestId: string,
  agentId: string,
) {
  const failed = await database.query<{
    id: string;
    card: Record<string, unknown>;
    agent_name: string;
  }>(
    `SELECT message.id,message.card,COALESCE(NULLIF(agent.name,''),'The agent') agent_name
     FROM messages message JOIN identities agent ON agent.id=$3
     WHERE message.room_id=$1 AND message.card_type='turn-failed' AND message.card->>'requestId'=$2
       AND message.card->>'agentId'=$3 AND message.card->>'state'='failed'`,
    [roomId, requestId, agentId],
  );
  for (const row of failed.rows)
    await restateSystemLine(
      database,
      row.id,
      {
        subject: { kind: 'agent', id: agentId, name: row.agent_name },
        verb: 'answered after a retry',
      },
      { ...row.card, state: 'recovered' },
    );
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
    if (scopedRoom && name !== 'ensureAgentMembership' && !this.commandTransaction)
      await this.access(scopedRoom, authenticatedAgentId);
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
    ]);
    if (
      !this.commandTransaction &&
      scopedRoom &&
      name === 'postRoomMessage' &&
      typedMentionHandles(String(candidate.text ?? '')).size === 0 &&
      typeof candidate.replyToMessageId !== 'string'
    )
      return (await this.postRoomMessage(
        input as Input<'postRoomMessage'>,
        authenticatedAgentId,
        true,
      )) as Output<Name>;
    if (!this.commandTransaction && scopedRoom && turnWrites.has(name)) {
      const writeStartedAt = Date.now();
      const events: LiveEvent[] = [];
      const buffered = new LiveHub();
      buffered.publish = (event) => {
        events.push(event);
      };
      const output = await this.database.transaction(async (db) => {
        const requestId = candidate.requestId ?? candidate.turnId;
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
          name === 'postRoomMessage' ||
          name === 'retractAgentLiveOutput' ||
          (name === 'postAgentTurnReceipt' && candidate.status === 'complete');
        const command = await authorizeCommandOutput(
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
              await db.query<{ id: string; created_at: Date; mention_ids: string[]; text: string }>(
                `SELECT id,created_at,mention_ids,text FROM messages WHERE id=$1`,
                [command.result_message_id],
              )
            ).rows[0]!;
            if (saved.text !== candidate.text) throw new Error('command result conflict');
            return {
              id: saved.id,
              createdAt: seconds(saved.created_at),
              mentionIds: saved.mention_ids,
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
        );
        const result = await scoped.execute(name, input, authenticatedAgentId);
        if (name === 'requestAgentGrant') {
          await db.query(
            `UPDATE agent_grants SET command_id=$2 WHERE id=$1 AND command_id IS NULL`,
            [(result as { grantId: string }).grantId, command.id],
          );
        }
        if (name === 'postRoomMessage') {
          const message = result as unknown as { id: string; mentionIds: string[] };
          if (message.mentionIds.length > 0) await routeAgentResult(db, command, message.id);
        } else if (name === 'postAgentTurnReceipt') {
          if (candidate.status === 'working')
            await db.query(
              `UPDATE agent_commands SET lease_expires_at=now()+interval '90 seconds' WHERE id=$1`,
              [command.id],
            );
          else
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
      case 'listAgentGrants':
        return (await this.listAgentGrants(authenticatedAgentId)) as Output<Name>;
      case 'consumeAgentGrant':
        return (await this.consumeAgentGrant(
          input as Input<'consumeAgentGrant'>,
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
      default:
        throw new Error(`unsupported daemon operation: ${String(name)}`);
    }
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
      mention_ids: string[];
      agent_mention_ids: string[];
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
        mentionIds: row.mention_ids ?? [],
        agentMentionIds: row.agent_mention_ids ?? [],
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
      `SELECT id::text id FROM media_expirations WHERE id=ANY($1::uuid[])`,
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
   */
  private async corners(roomId: string, agentId: string) {
    await this.access(roomId, agentId);
    const rows = await this.database.query<{
      id: string;
      parent_id: string;
      created_by: string | null;
      archived: boolean;
    }>(
      `SELECT r.id,r.parent_id,f.owner_agent_id created_by,r.archived_at IS NOT NULL archived
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
      })),
    };
  }
  private async cornerRestore(cornerId: string, agentId: string) {
    await this.access(cornerId, agentId);
    const row = (
      await this.database.query<{
        objective: string;
        feature_branch: string | null;
        request_id: string | null;
        close_requested: boolean;
        lifecycle: import('@beeline/api-contract/phone').CornerLifecycleView;
        pull_request_number: number | null;
        approval_head_sha: string | null;
      }>(
        `SELECT fact.objective,fact.feature_branch,fact.request_id,fact.close_requested,fact.lifecycle,
           approval.pull_request_number,approval.head_sha approval_head_sha
         FROM corner_facts fact
         LEFT JOIN corner_merge_approvals approval ON approval.corner_id=fact.corner_id
         WHERE fact.corner_id=$1`,
        [cornerId],
      )
    ).rows[0];
    return {
      cornerId,
      objective: row?.objective ?? '',
      ...(row?.feature_branch ? { featureBranch: row.feature_branch } : {}),
      ...(row?.request_id ? { requestId: row.request_id } : {}),
      closeRequested: row?.close_requested ?? false,
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
  private async repository(roomId: string, agentId: string) {
    await this.access(roomId, agentId);
    const row = (
      await this.database.query<{
        repository_key: string | null;
        repository_remote: string | null;
        repository_target_branch: string;
        direct_participants: string[] | null;
      }>(
        `SELECT repository_key,repository_remote,repository_target_branch,direct_participants FROM rooms WHERE id=$1`,
        [roomId],
      )
    ).rows[0];
    return row?.repository_key
      ? {
          key: row.repository_key,
          remote: row.repository_remote ?? undefined,
          targetBranch: row.repository_target_branch,
          resolution: 'repository' as const,
        }
      : {
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
        commands: Array<{ name: string; description?: string }>;
        yolo_mode: boolean;
        reviewer_handle: string | null;
      }>(
        `SELECT a.soul,a.selected_model,a.selected_effort,a.commands,
                CASE WHEN workspace.visibility='public' THEN false ELSE a.yolo_mode END yolo_mode,
                CASE WHEN room.parent_id IS NOT NULL AND reviewer.id<>a.agent_id
                     THEN reviewer.handle END reviewer_handle
         FROM agents a
         LEFT JOIN rooms room ON room.id=$2
         LEFT JOIN workspaces workspace ON workspace.id=room.workspace_id
         LEFT JOIN rooms parent ON parent.id=room.parent_id
         LEFT JOIN memberships reviewer_membership
           ON reviewer_membership.room_id=parent.id
          AND reviewer_membership.identity_id=parent.reviewer_agent_id
          AND reviewer_membership.removed_at IS NULL
         LEFT JOIN identities reviewer
           ON reviewer.id=reviewer_membership.identity_id AND reviewer.kind='agent'
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
  private async postRoomMessage(
    input: Input<'postRoomMessage'>,
    agentId: string,
    atomicCommandWrite = false,
  ) {
    if (!this.commandTransaction && !atomicCommandWrite) await this.access(input.roomId, agentId);
    const messageId = id();
    const resolvedMentions = await resolveCurrentMemberMentions(
      this.database,
      input.roomId,
      input.text,
      agentId,
    );
    const agentMentionIds = new Set(
      resolvedMentions.filter((mention) => mention.kind === 'agent').map((mention) => mention.id),
    );
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
    const humanIds = new Set(
      resolvedMentions.filter((mention) => mention.kind === 'human').map((mention) => mention.id),
    );
    // A tag an agent writes reaches the person it names, exactly as a
    // human-authored one does: the same stored mention id, the same push
    // fan-out, the same highlight. There is no per-turn numeric cap. One kept
    // only the FIRST human id in the reply's resolution order and dropped every
    // other tag, so a correctly spelled handle vanished with nothing said to
    // anybody — a laundered tag, which is worse than the over-tagging it was
    // meant to stop. How often an agent should tag a human is a matter for its
    // instructions (`beeline-skill.ts`), never for a silent truncation.
    let deliveredMentions = resolvedMentions.map((mention) => mention.id);
    if (humanIds.size) {
      // The one human-tag rule that is not a cap: a corner agent must not tag
      // the user on completion, because the merge summary card and its push
      // already cover that. Turn-settling corner posts deliver no human
      // mentions at all.
      const corner = (
        await this.database.query<{ corner: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM corner_facts WHERE corner_id=rooms.id) corner
           FROM rooms WHERE rooms.id=$1`,
          [input.roomId],
        )
      ).rows[0];
      if (corner?.corner && input.requestId) {
        deliveredMentions = deliveredMentions.filter((value) => !humanIds.has(value));
      }
    }
    const rootMessageId = input.replyToMessageId
      ? (parent!.root_message_id ?? input.replyToMessageId)
      : null;
    // Turns are unthreaded by design. Count from the inbox item that woke this
    // agent, not the optional presentation reply parent; a human item starts a
    // fresh chain at zero.
    const hopCount = command?.agent_depth ?? 0;
    const persistedMentions = deliveredMentions;
    let messageWriteStartedAt: number | undefined;
    const saveCompatibilityReply = async (database: SqlDatabase) => {
      // Attachments queued this turn by beeline-agent attach_file ride on this
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
        JSON.stringify(persistedMentions),
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
                 id,room_id,author_id,text,presentation,request_id,legacy_event,mention_ids,
                 reply_to_message_id,root_message_id,agent_hop_count,attachments
               ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb)
               RETURNING *
             ), completed AS (
               UPDATE agent_commands SET state='complete',completed_at=now(),result_message_id=inserted.id
               FROM inserted WHERE agent_commands.id=$13
             ), cleared AS (
               DELETE FROM live_outputs
               WHERE room_id=$2 AND agent_id=$3 AND turn_id=$6 AND kind IN ('draft','thought')
             )
             SELECT inserted.*,author.kind author_kind,author.name author_name,
               author.handle author_handle,author.avatar author_avatar,author.face_id author_face
             FROM inserted JOIN identities author ON author.id=inserted.author_id`,
            [...values, command!.id],
          )
        ).rows[0]!;
      }
      return (
        await database.query<CommittedMessageLiveRow>(
          `WITH inserted AS (
             INSERT INTO messages(
               id,room_id,author_id,text,presentation,request_id,legacy_event,mention_ids,
               reply_to_message_id,root_message_id,agent_hop_count,attachments
             ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb)
             RETURNING *
           )
           SELECT inserted.*,author.kind author_kind,author.name author_name,
             author.handle author_handle,author.avatar author_avatar,author.face_id author_face
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
               AND command.action IN ('input','resume') AND command.generation_id=$11
             ORDER BY command.created_at DESC,command.id DESC LIMIT 1 FOR UPDATE OF command
           ), writable AS (
             SELECT * FROM candidate
             WHERE state='claimed' AND lease_expires_at>clock_timestamp() AND NOT turn_cancelled
           ), pending AS (
             DELETE FROM agent_pending_attachments attachment USING writable
             WHERE attachment.room_id=$2 AND attachment.agent_id=$3
               AND attachment.request_id=$6 AND attachment.generation_id=$11
             RETURNING attachment.url,attachment.name,attachment.mime_type,attachment.size,
               attachment.created_at,attachment.id
           ), attachment_payload AS (
             SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'url',url,'name',name,'mimeType',mime_type,'size',size::integer
             ) ORDER BY created_at,id),'[]'::jsonb) attachments FROM pending
           ), settled AS (
             INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
             SELECT room_id,turn_request_id,agent_id,'complete',$11 FROM writable
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
               AND failure.card->>'state'='failed'
             RETURNING failure.*
           ), recovered_public AS (
             SELECT recovered.*,author.kind author_kind,author.name author_name,
               author.handle author_handle,author.avatar author_avatar,author.face_id author_face
             FROM recovered JOIN identities author ON author.id=recovered.author_id
           ), recovery_barrier AS (
             SELECT count(*) recovered_count,
               (jsonb_agg(to_jsonb(recovered_public))->0) recovered_row
             FROM recovered_public
           ), inserted AS (
             INSERT INTO messages(
               id,room_id,author_id,text,presentation,request_id,legacy_event,mention_ids,
               reply_to_message_id,root_message_id,agent_hop_count,attachments
             ) SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,
                 writable.agent_depth,attachment_payload.attachments
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
               author.handle author_handle,author.avatar author_avatar,author.face_id author_face
             FROM inserted JOIN identities author ON author.id=inserted.author_id
             CROSS JOIN completed
           ), existing_public AS (
             SELECT message.*,author.kind author_kind,author.name author_name,
               author.handle author_handle,author.avatar author_avatar,author.face_id author_face
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
          JSON.stringify(persistedMentions),
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
      mentionIds: saved.mention_ids,
    };
  }
  /** An agent-claimed attachment queued by attach_file; stamped onto the agent's
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
    const owned = await this.database.query(`SELECT 1 FROM media WHERE id=$1 AND owner_id=$2`, [
      mediaId,
      agentId,
    ]);
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
    await this.database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
      [input.roomId, agentId, input.turnId, kind, JSON.stringify({ text: input.text })],
    );
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
    const reason =
      input.status === 'failed' && typeof input.reason === 'string'
        ? input.reason.replace(/\s+/g, ' ').trim().slice(0, TURN_FAILURE_REASON_MAX) || null
        : null;
    let committedTurn: CommittedTurnLiveRow | undefined;
    await this.database.transaction(async (database) => {
      if (input.heartbeat) {
        committedTurn = (
          await database.query<CommittedTurnLiveRow>(
            `WITH written AS (
               UPDATE agent_turns SET created_at=now()
               WHERE room_id=$1 AND request_id=$2 AND agent_id=$3 AND status='working'
                 AND generation_id IS NOT DISTINCT FROM $4
               RETURNING room_id,request_id,agent_id,status,created_at,generation_id
             )
             SELECT written.*,requester.id requested_by FROM written
             LEFT JOIN messages trigger ON trigger.id=written.request_id
               AND (trigger.room_id=$1 OR trigger.room_id=(SELECT parent_id FROM rooms WHERE id=$1))
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
             RETURNING room_id,request_id,agent_id,status,created_at,generation_id
           )
           SELECT written.*,requester.id requested_by FROM written
           LEFT JOIN messages trigger ON trigger.id=written.request_id
             AND (trigger.room_id=$1 OR trigger.room_id=(SELECT parent_id FROM rooms WHERE id=$1))
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
        await this.inscribeTurnFailure(
          database,
          input.roomId,
          input.requestId,
          agentId,
          reason,
          input.reasonKind,
        );
      } else if (input.status === 'complete') {
        await settleTurnFailureLine(database, input.roomId, input.requestId, agentId);
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
    return this.writeResult();
  }
  /**
   * A failed turn is a fact the Room must carry. When a human asked, ONE
   * `presentation='system'` line names the agent and the reason; retries of
   * the same request within ten minutes update that line in place. A later
   * success settles the same row to "answered after a retry" — an inscribed
   * record that stays true, never a stamped stale failure.
   *
   * The line carries NO mention. A push comes from exactly three sources — a
   * person tags you, a corner opens or closes, one push per member join — and
   * a system line never claims one through a synthetic mention (captain
   * report C68: "Candy could not answer" pushed to the requester's phone).
   * `background.ts` also excludes `turn-failed` rows outright.
   */
  private async inscribeTurnFailure(
    database: SqlDatabase,
    roomId: string,
    requestId: string,
    agentId: string,
    reason: string | null,
    reasonKind?: 'model-selection-unavailable',
  ) {
    const trigger = (
      await database.query<{ author_id: string; agent_name: string; agent_handle: string | null }>(
        `SELECT message.author_id,COALESCE(NULLIF(agent.name,''),'The agent') agent_name,
                agent.handle agent_handle
         FROM messages message
         JOIN identities requester ON requester.id=message.author_id AND requester.kind='human'
         JOIN identities agent ON agent.id=$3
         WHERE message.id=$2 AND message.presentation IN ('message','system')
           AND (message.room_id=$1 OR message.room_id=(SELECT parent_id FROM rooms WHERE id=$1))`,
        [roomId, requestId, agentId],
      )
    ).rows[0];
    if (!trigger) return;
    const phrase: SystemPhrase =
      reasonKind === 'model-selection-unavailable'
        ? {
            subject: {
              kind: 'agent',
              id: agentId,
              name: trigger.agent_handle ? `@${trigger.agent_handle}` : trigger.agent_name,
            },
            verb: 'is not available',
            consequence: 'ask its owner',
          }
        : {
            subject: { kind: 'agent', id: agentId, name: trigger.agent_name },
            verb: 'could not answer',
            ...(reason ? { consequence: reason } : {}),
          };
    const recent = (
      await database.query<{ id: string }>(
        `SELECT id FROM messages WHERE room_id=$1 AND card_type='turn-failed'
           AND card->>'requestId'=$2 AND card->>'agentId'=$3 AND card->>'state'='failed'
           AND created_at>now()-interval '10 minutes'
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [roomId, requestId, agentId],
      )
    ).rows[0];
    if (recent) {
      await restateSystemLine(database, recent.id, phrase);
      return;
    }
    await systemLine(database, {
      roomId,
      ...phrase,
      cardType: 'turn-failed',
      card: { requestId, agentId, state: 'failed' },
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
        `INSERT INTO messages(id,room_id,author_id,text,presentation,request_id,activity)
         VALUES($1,$2,$3,'','activity',$4,$5::jsonb)
         ON CONFLICT(id) DO NOTHING
         RETURNING id,created_at`,
        [messageId, input.roomId, agentId, input.requestId, JSON.stringify(input.activity)],
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
    const updated = await this.database.query(
      `UPDATE memberships SET event_subscriptions=$3::jsonb
       WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
      [input.roomId, agentId, JSON.stringify(kinds)],
    );
    if (!updated.rowCount) throw new Error('daemon room access denied');
    return { kinds };
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
    const mentions = [...new Set(input.mentionAgentIds ?? [])];
    if (mentions.length > MAX_MENTIONS_PER_EVENT)
      throw new Error(`an event may wake at most ${MAX_MENTIONS_PER_EVENT} agents`);
    if (mentions.length) {
      const members = await this.database.query<{ identity_id: string }>(
        `SELECT member.identity_id FROM memberships member
         JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
         WHERE member.room_id=$1 AND member.removed_at IS NULL
           AND member.identity_id=ANY($2::text[])`,
        [input.roomId, mentions],
      );
      const present = new Set(members.rows.map((row) => row.identity_id));
      const missing = mentions.filter((mention) => !present.has(mention));
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
      mentions,
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
   * the Room, addressed to the owner so the tagged-mention push fires. Budget
   * always asks (the cap is out of scope), even under yolo.
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
    const requesterRow = (
      await this.database.query<{
        id: string;
        kind: 'human' | 'agent';
        name: string;
        handle: string | null;
        avatar: string | null;
      }>(
        `SELECT identity.id,identity.kind,identity.name,identity.handle,identity.avatar
         FROM messages message JOIN identities identity ON identity.id=message.author_id
         WHERE message.room_id=$1 AND message.author_id<>$2
           AND message.mention_ids @> $3::jsonb AND message.presentation IN ('message','system')
         ORDER BY message.created_at DESC,message.id DESC LIMIT 1`,
        [input.roomId, agentId, JSON.stringify([agentId])],
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
    const auto = context.yolo_mode && kind !== 'budget' && escalations.length === 0;
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
        mentions: [owner.pubkey],
        presentation: 'card',
        cardType: 'grant-request',
        card: { agent, owner, requester, grants: [grantView] },
      });
      return { messageId };
    });
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'grant', agentId });
    return {
      grantId,
      status,
      auto,
      ...(result.messageId ? { messageId: result.messageId } : {}),
      ...(escalations.length ? { escalations } : {}),
    };
  }
  /** Every live rule for this agent: approved or once, unexpired, not revoked. */
  private async listAgentGrants(agentId: string) {
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
       ORDER BY g.created_at DESC,g.id`,
      [agentId],
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
  private async createCorner(input: Input<'createCorner'>, agentId: string) {
    // Untidy is not wrong: a brief handed over with line breaks or double
    // spaces is flattened here, and only a genuinely over-long text is
    // refused — in a sentence that names the limit and the count (C90).
    const objective = normalizeCornerText(input.objective ?? '');
    const name = normalizeCornerText(input.name ?? '');
    const refusal =
      cornerTextRefusal('name', input.name) ?? cornerTextRefusal('objective', input.objective);
    if (refusal) throw new Error(refusal);
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
      // Opening a corner is idempotent for the originating task while that
      // corner remains active. Locking the parent closes the read/insert race:
      // a concurrent retry waits, sees the winner, and returns its id without
      // creating another Room, command, or open card.
      await db.query(`SELECT id FROM rooms WHERE id=$1 FOR UPDATE`, [input.roomId]);
      const existing = (
        await db.query<{ corner_id: string }>(
          `SELECT child.id::text corner_id
           FROM rooms child
           JOIN corner_facts fact ON fact.corner_id=child.id
           WHERE child.parent_id=$1 AND fact.request_id=$2 AND child.archived_at IS NULL
           ORDER BY child.created_at,child.id
           LIMIT 1`,
          [input.roomId, input.requestId],
        )
      ).rows[0];
      if (existing) {
        cornerId = existing.corner_id;
        return;
      }
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
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         SELECT workspace_id,$2,identity_id,role FROM memberships
         WHERE room_id=$1 AND removed_at IS NULL ON CONFLICT DO NOTHING`,
        [input.roomId, cornerId],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')
         ON CONFLICT(room_id,identity_id) WHERE room_id IS NOT NULL
         DO UPDATE SET role='owner',removed_at=NULL`,
        [parent.workspace_id, cornerId, agentId],
      );
      await db.query(
        `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,request_id,lifecycle) VALUES($1,$2,$3,$4,'{"lifecycle":"working","checks":"unknown"}')`,
        [cornerId, agentId, objective, input.requestId],
      );
      const parentCommand = await authorizeCommandOutput(
        db,
        input.roomId,
        agentId,
        input.requestId,
        input.generationId,
      );
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
      // a daemon-fact card and the push rule fires on it.
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
  private async access(roomId: string, agentId: string) {
    const result = await this.database.query(
      `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
      [roomId, agentId],
    );
    if (!result.rowCount) throw new Error('daemon room access denied');
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
  private writeResult() {
    return { id: id(), createdAt: Math.floor(Date.now() / 1000) };
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
const conversationColumns = `SELECT id,author_id,created_at,presentation,text,mention_ids,
        ARRAY(SELECT mentioned.id
              FROM jsonb_array_elements_text(messages.mention_ids) mention(id)
              JOIN identities mentioned ON mentioned.id=mention.id
              WHERE mentioned.kind='agent') agent_mention_ids,
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
  postCornerLifecycle: true,
  postCornerRemoteState: true,
  postCornerPlan: true,
  postTargetBranchProposal: true,
  requestAgentGrant: true,
  listAgentGrants: true,
  consumeAgentGrant: true,
  createCorner: true,
  archiveCorner: true,
  ensureAgentMembership: true,
};
export const DAEMON_OPERATION_NAMES = new Set(
  Object.keys(DAEMON_OPERATION_ROUTES) as (keyof DaemonOperationMap)[],
);
