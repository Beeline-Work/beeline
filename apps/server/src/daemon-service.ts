import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  DaemonAttachment,
  DaemonOperationMap,
  SystemEvent,
} from '@beeline/api-contract/daemon';
import { cornerTextRefusal, normalizeCornerText } from '@beeline/api-contract/daemon';
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
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import { restateSystemLine, systemLine, type SystemPhrase } from './system-line.js';

type Input<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['input'];
type Output<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['output'];
const id = () => randomBytes(32).toString('hex');

/** Server-side cap on the daemon's distilled failure reason (matches the daemon's own cap). */
const TURN_FAILURE_REASON_MAX = 200;

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
const seconds = (date: Date) => Math.floor(date.getTime() / 1_000);
const AGENT_TO_AGENT_HOP_CAP = 3;
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
  ) {}

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
    if (scopedRoom && name !== 'ensureAgentMembership')
      await this.access(scopedRoom, authenticatedAgentId);
    if (scopedRoom && this.isCornerWrite(name))
      await this.assertCornerOwner(scopedRoom, authenticatedAgentId);
    switch (name) {
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
          input as Input<'getRoomInbox'>,
          authenticatedAgentId,
        )) as Output<Name>;
      case 'getRoomAuthority':
        return (await this.roomAuthority(input as Input<'getRoomAuthority'>)) as Output<Name>;
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
        return (await this.configuration(authenticatedAgentId)) as Output<Name>;
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
      case 'postAgentPresence':
        return (await this.postPresence(
          input as Input<'postAgentPresence'>,
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
         COALESCE(m.identity_profile->>'kind',i.kind) kind,
         COALESCE(m.identity_profile->>'name',i.name) name,
         CASE WHEN m.identity_profile IS NOT NULL THEN m.identity_profile->>'handle' ELSE i.handle END handle,
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
  private async inbox(name: string, input: Input<'getRoomInbox'>, agentId: string) {
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
    if (input.startAtLatest) {
      if (input.after) throw new Error('startAtLatest cannot be combined with after');
      const latest = await this.database.query<{
        id: string;
        created_at: Date;
        cursor_ms: string;
      }>(
        `SELECT id,created_at,floor(extract(epoch FROM created_at)*1000)::bigint cursor_ms
         FROM messages WHERE room_id=$1 ORDER BY cursor_ms DESC,id DESC LIMIT 1`,
        [roomId],
      );
      const highWater = latest.rows[0];
      return {
        items: [],
        ...(highWater ? { cursor: `${highWater.cursor_ms},${highWater.id}` } : {}),
        ...(closeRequested !== undefined ? { closeRequested } : {}),
      };
    }
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    const after = input.after?.match(/^(\d+),([0-9a-f]{64})$/);
    if (input.after && !after) throw new Error('invalid inbox cursor');
    const rows = await this.database.query<{
      id: string;
      author_id: string;
      created_at: Date;
      presentation: string;
      text: string;
      mention_ids: string[];
      reply_to_message_id: string | null;
      root_message_id: string | null;
      request_id: string | null;
      attachments: DaemonAttachment[];
      cursor_ms: string;
      system_event: SystemEvent | null;
    }>(
      `SELECT id,author_id,created_at,presentation,text,mention_ids,reply_to_message_id,
        root_message_id,request_id,attachments,system_event,
        floor(extract(epoch FROM created_at)*1000)::bigint cursor_ms
        FROM messages WHERE room_id=$1
          ${after ? 'AND (floor(extract(epoch FROM created_at)*1000)::bigint,id)>($2::bigint,$3)' : ''}
        ORDER BY cursor_ms,id LIMIT ${limit + 1}`,
      after ? [roomId, after[1], after[2]] : [roomId],
    );
    const page = rows.rows.slice(0, limit);
    const visiblePage =
      name === 'getRoomInbox'
        ? page.filter(
            (row) =>
              row.presentation === 'system' ||
              (row.author_id !== agentId && (row.mention_ids ?? []).includes(agentId)),
          )
        : page;
    return {
      items: visiblePage.map((row) => ({
        id: row.id,
        authorId: row.author_id,
        createdAt: seconds(row.created_at),
        type: row.presentation,
        body: row.text,
        mentionIds: row.mention_ids ?? [],
        ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
        ...(row.root_message_id ? { rootMessageId: row.root_message_id } : {}),
        ...(row.request_id ? { requestId: row.request_id } : {}),
        attachments: row.attachments ?? [],
        ...(row.system_event ? { systemEvent: row.system_event } : {}),
      })),
      ...(page.at(-1) ? { cursor: `${page.at(-1)!.cursor_ms},${page.at(-1)!.id}` } : {}),
      ...(closeRequested !== undefined ? { closeRequested } : {}),
    };
  }
  private async roomAuthority(input: Input<'getRoomAuthority'>) {
    const row = (
      await this.database.query<{
        workspace_id: string;
        role: 'owner' | 'admin' | 'member';
        kind: 'human' | 'agent';
        archived: boolean;
      }>(
        `SELECT r.workspace_id,m.role,i.kind,r.archived_at IS NOT NULL archived FROM rooms r LEFT JOIN memberships m ON m.room_id=r.id AND m.identity_id=$2 AND m.removed_at IS NULL LEFT JOIN identities i ON i.id=$2 WHERE r.id=$1`,
        [input.roomId, input.principalId],
      )
    ).rows[0];
    return row
      ? {
          workspaceId: row.workspace_id,
          member: Boolean(row.role),
          ...(row.role ? { role: row.role } : {}),
          ...(row.kind ? { principalKind: row.kind } : {}),
          archived: row.archived,
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
       WHERE r.parent_id=$1 AND f.owner_agent_id=$2`,
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
        feature_branch: string | null;
        request_id: string | null;
        close_requested: boolean;
        lifecycle: import('@beeline/api-contract/phone').CornerLifecycleView;
      }>(
        `SELECT feature_branch,request_id,close_requested,lifecycle FROM corner_facts WHERE corner_id=$1`,
        [cornerId],
      )
    ).rows[0];
    return {
      cornerId,
      ...(row?.feature_branch ? { featureBranch: row.feature_branch } : {}),
      ...(row?.request_id ? { requestId: row.request_id } : {}),
      closeRequested: row?.close_requested ?? false,
      ...(row?.lifecycle ? { lifecycle: row.lifecycle } : {}),
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
  private async configuration(agentId: string) {
    const row = (
      await this.database.query<{
        soul: { name: string; instructions: string } | null;
        selected_model: string | null;
        selected_effort: string | null;
        commands: Array<{ name: string; description?: string }>;
        yolo_mode: boolean;
      }>(
        `SELECT a.soul,a.selected_model,a.selected_effort,a.commands,a.yolo_mode
         FROM agents a
         WHERE a.agent_id=$1`,
        [agentId],
      )
    ).rows[0];
    return {
      ...(row?.soul ? { soul: { name: row.soul.name, instructions: row.soul.instructions } } : {}),
      ...(row?.selected_model ? { model: row.selected_model } : {}),
      ...(row?.selected_effort ? { effort: row.selected_effort } : {}),
      commands: row?.commands ?? [],
      yoloMode: row?.yolo_mode ?? false,
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
        `SELECT body,updated_at FROM live_outputs WHERE room_id=$1 AND agent_id=$2 AND kind='presence' ORDER BY updated_at DESC LIMIT 1`,
        [input.roomId, agentId],
      )
    ).rows[0];
    return row
      ? {
          status: row.body.status,
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
      body: {
        status?: string;
        observedAt?: number;
        releaseVersion?: string;
        sourceSha?: string;
      } | null;
    }>(
      `SELECT a.agent_id,lo.body
       FROM agents a
       LEFT JOIN LATERAL(
         SELECT body FROM live_outputs
         WHERE agent_id=a.agent_id AND kind='presence'
         ORDER BY (
           body->>'status'='online' AND updated_at >= now() - interval '90 seconds'
         ) DESC,updated_at DESC LIMIT 1
       )lo ON true
       WHERE EXISTS(
         SELECT 1 FROM memberships m
         WHERE m.identity_id=a.agent_id AND m.room_id IS NULL AND m.removed_at IS NULL
       )
       ORDER BY a.agent_id`,
    );
    const now = Date.now();
    const daemons = result.rows.map((row) => {
      const observedAt = row.body?.observedAt;
      const fresh = typeof observedAt === 'number' && Math.abs(now - observedAt * 1_000) <= 90_000;
      const state = !row.body
        ? 'never-seen'
        : row.body.status !== 'online'
          ? 'offline'
          : fresh
            ? 'ready'
            : 'stale';
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
  private async postRoomMessage(input: Input<'postRoomMessage'>, agentId: string) {
    await this.access(input.roomId, agentId);
    const messageId = id();
    const mentions = [...new Set(input.mentionIds ?? [])].filter((value) => value !== agentId);
    let agentMentionIds = new Set<string>();
    let memberIds = new Set<string>();
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
    const trigger = input.triggerMessageId
      ? (
          await this.database.query<{
            agent_hop_count: number;
            author_kind: 'human' | 'agent';
          }>(
            `SELECT message.agent_hop_count,identity.kind author_kind
             FROM messages message JOIN identities identity ON identity.id=message.author_id
             WHERE message.id=$1 AND message.room_id=$2 AND message.mention_ids @> $3::jsonb`,
            [input.triggerMessageId, input.roomId, JSON.stringify([agentId])],
          )
        ).rows[0]
      : (
          await this.database.query<{
            agent_hop_count: number;
            author_kind: 'agent';
          }>(
            `SELECT message.agent_hop_count,identity.kind author_kind
             FROM messages message JOIN identities identity ON identity.id=message.author_id
             WHERE message.room_id=$1 AND identity.kind='agent' AND message.author_id<>$2
               AND message.mention_ids @> $3::jsonb
             ORDER BY message.created_at DESC,message.id DESC LIMIT 1`,
            [input.roomId, agentId, JSON.stringify([agentId])],
          )
        ).rows[0];
    if (input.triggerMessageId && !trigger) throw new Error('turn trigger is invalid for agent');
    let humanIds = new Set<string>();
    if (mentions.length) {
      const members = await this.database.query<{ identity_id: string; kind: 'human' | 'agent' }>(
        `SELECT membership.identity_id,identity.kind FROM memberships membership
         JOIN identities identity ON identity.id=membership.identity_id
         WHERE membership.room_id=$1 AND membership.removed_at IS NULL
           AND membership.identity_id=ANY($2::text[])`,
        [input.roomId, mentions],
      );
      memberIds = new Set(members.rows.map((row) => row.identity_id));
      agentMentionIds = new Set(
        members.rows.filter((row) => row.kind === 'agent').map((row) => row.identity_id),
      );
      humanIds = new Set(
        members.rows.filter((row) => row.kind === 'human').map((row) => row.identity_id),
      );
    }
    // Mentions are server-validated against the Room roster: a member mention
    // (human or agent) becomes a real mention; an unknown name stays plain text.
    const validatedMentions = mentions.filter((value) => memberIds.has(value));
    // At most ONE human mention per agent turn is delivered; further human tags
    // in the same message stay as plain text.
    let deliveredMentions = validatedMentions;
    const firstHumanMention = validatedMentions.find((value) => humanIds.has(value));
    if (firstHumanMention) {
      deliveredMentions = validatedMentions.filter(
        (value) => !humanIds.has(value) || value === firstHumanMention,
      );
      // A corner agent must not tag the user on completion: the merge summary
      // card and its push already cover that. Turn-settling corner posts
      // deliver no human mentions at all.
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
    const hopCount = trigger?.author_kind === 'agent' ? trigger.agent_hop_count + 1 : 0;
    const capped = agentMentionIds.size > 0 && hopCount >= AGENT_TO_AGENT_HOP_CAP;
    await this.database.transaction(async (database) => {
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
           WHERE room_id=$1 AND agent_id=$2 ORDER BY created_at,id`,
          [input.roomId, agentId],
        )
      ).rows;
      await database.query(
        `INSERT INTO messages(
           id,room_id,author_id,text,presentation,request_id,legacy_event,mention_ids,
           reply_to_message_id,root_message_id,agent_hop_count,attachments
         ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb)`,
        [
          messageId,
          input.roomId,
          agentId,
          input.text,
          // The daemon posts conversation (or a card); a system line is only
          // ever phrased by the server (`system-line.ts`).
          input.presentation === 'card' ? 'card' : 'message',
          input.requestId ?? null,
          JSON.stringify(input.tags ?? {}),
          JSON.stringify(
            capped
              ? deliveredMentions.filter((value) => !agentMentionIds.has(value))
              : deliveredMentions,
          ),
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
        ],
      );
      if (pending.length)
        await database.query(
          `DELETE FROM agent_pending_attachments WHERE room_id=$1 AND agent_id=$2`,
          [input.roomId, agentId],
        );
      // A durable final Room reply is also the turn's terminal proof. This
      // makes the Room view settle even if the daemon is interrupted before
      // its redundant explicit complete receipt reaches the server.
      if (input.requestId) {
        await database.query(
          `INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
           VALUES($1,$2,$3,'complete',NULL)
           ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET
             status='complete',created_at=now()`,
          [input.roomId, input.requestId, agentId],
        );
        await settleTurnFailureLine(database, input.roomId, input.requestId, agentId);
      }
    });
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message' });
    return { id: messageId, createdAt: Math.floor(Date.now() / 1000) };
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
      `INSERT INTO agent_pending_attachments(room_id,agent_id,url,name,mime_type,size)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        input.roomId,
        agentId,
        attachment.url,
        attachment.name,
        attachment.mimeType,
        attachment.size,
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
    await this.database.transaction(async (database) => {
      if (input.heartbeat) {
        await database.query(
          `UPDATE agent_turns SET created_at=now()
           WHERE room_id=$1 AND request_id=$2 AND agent_id=$3 AND status='working'
             AND generation_id IS NOT DISTINCT FROM $4`,
          [input.roomId, input.requestId, agentId, input.generationId ?? null],
        );
      } else {
        await database.query(
          `INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id,failure_reason) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET status=EXCLUDED.status,generation_id=EXCLUDED.generation_id,failure_reason=EXCLUDED.failure_reason,created_at=now()`,
          [
            input.roomId,
            input.requestId,
            agentId,
            input.status,
            input.generationId ?? null,
            reason,
          ],
        );
      }
      if (input.status === 'failed') {
        await this.inscribeTurnFailure(database, input.roomId, input.requestId, agentId, reason);
      } else if (input.status === 'complete') {
        await settleTurnFailureLine(database, input.roomId, input.requestId, agentId);
      }
    });
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'turn' });
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
  ) {
    const trigger = (
      await database.query<{ author_id: string; agent_name: string }>(
        `SELECT message.author_id,COALESCE(NULLIF(agent.name,''),'The agent') agent_name
         FROM messages message
         JOIN identities requester ON requester.id=message.author_id AND requester.kind='human'
         JOIN identities agent ON agent.id=$3
         WHERE message.id=$2 AND message.presentation IN ('message','system')
           AND (message.room_id=$1 OR message.room_id=(SELECT parent_id FROM rooms WHERE id=$1))`,
        [roomId, requestId, agentId],
      )
    ).rows[0];
    if (!trigger) return;
    const phrase: SystemPhrase = {
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
    const messageId = id();
    await this.database.transaction(async (database) => {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,request_id,activity) VALUES($1,$2,$3,'','activity',$4,$5::jsonb)`,
        [messageId, input.roomId, agentId, input.requestId, JSON.stringify(input.activity)],
      );
      await database.query(
        `UPDATE agent_turns SET created_at=now()
         WHERE room_id=$1 AND request_id=$2 AND agent_id=$3 AND status='working'`,
        [input.roomId, input.requestId, agentId],
      );
    });
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'activity' });
    return { id: messageId, createdAt: Math.floor(Date.now() / 1000) };
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
        verb: `asked ${requester.name} to`,
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
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'permission' });
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
  private async postPresence(input: Input<'postAgentPresence'>, agentId: string) {
    const observedAt = Math.floor(Date.now() / 1000);
    await this.database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence',$3::jsonb) ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
      [
        input.roomId,
        agentId,
        JSON.stringify({
          status: input.status,
          observedAt,
          ...(input.releaseVersion ? { releaseVersion: input.releaseVersion } : {}),
          ...(input.sourceSha ? { sourceSha: input.sourceSha } : {}),
        }),
      ],
    );
    this.live.publish({
      type: 'presence',
      roomId: input.roomId,
      agentId,
      status: input.status,
      observedAt,
    });
    return this.writeResult();
  }
  private async modelCatalog(input: Input<'postAgentModelCatalog'>, agentId: string) {
    await this.database.query(
      `UPDATE agents SET model_catalog=$2::jsonb,selected_model=COALESCE($3,selected_model),selected_effort=COALESCE($4,selected_effort),updated_at=now() WHERE agent_id=$1`,
      [
        agentId,
        JSON.stringify(input.options),
        input.selection?.model ?? null,
        input.selection?.effort ?? null,
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
        `SELECT room.workspace_id,room.parent_id,a.owner_id,a.yolo_mode,
                agent.name agent_name,agent.handle agent_handle,agent.avatar agent_avatar,
                owner.name owner_name,owner.handle owner_handle,owner.avatar owner_avatar
         FROM rooms room
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
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'grant' });
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
    const cornerId = randomUUID();
    const opener = await this.identity(agentId);
    await this.database.transaction(async (db) => {
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
      // One durable open marker in the parent Room; the phone renders this as
      // a daemon-fact card and the push rule fires on it.
      await systemLine(db, {
        roomId: input.roomId,
        subject: { kind: 'agent', id: agentId, name: opener.name },
        verb: 'opened a corner',
        // The NAME titles the corner everywhere; the objective is the card body.
        object: { text: name, id: cornerId },
        presentation: 'card',
        cardType: 'daemon-fact',
        card: { type: 'corner-open', cornerId, name, objective },
      });
    });
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'corner' });
    return { cornerId };
  }
  private async archiveCorner(cornerId: string, agentId: string) {
    await this.access(cornerId, agentId);
    await this.database.query(`UPDATE rooms SET archived_at=now(),updated_at=now() WHERE id=$1`, [
      cornerId,
    ]);
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
  private async access(roomId: string, agentId: string) {
    const result = await this.database.query(
      `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
      [roomId, agentId],
    );
    if (!result.rowCount) throw new Error('daemon room access denied');
  }
  private isCornerWrite(name: keyof DaemonOperationMap): boolean {
    return new Set<keyof DaemonOperationMap>([
      'postRoomMessage',
      'postAgentAttachment',
      'postAgentDraft',
      'postAgentThought',
      'retractAgentLiveOutput',
      'postAgentTurnReceipt',
      'postAgentActivity',
      'postPermissionRequest',
      'postPermissionExecution',
      'postWorkSchedule',
      'postWorkScheduleReceipt',
      'createAgentSchedule',
      'deleteAgentSchedule',
      'postAgentToolMandate',
      'postAgentPresence',
      'postCornerLifecycle',
      'postCornerRemoteState',
      'postCornerPlan',
      'postTargetBranchProposal',
      'requestAgentGrant',
      'archiveCorner',
    ]).has(name);
  }
  private async assertCornerOwner(roomId: string, agentId: string) {
    const corner = await this.database.query<{ owner_agent_id: string | null }>(
      `SELECT fact.owner_agent_id
       FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id
       WHERE room.id=$1 AND room.parent_id IS NOT NULL`,
      [roomId],
    );
    const owner = corner.rows[0]?.owner_agent_id;
    if (corner.rowCount && owner !== agentId) throw new Error('daemon corner access denied');
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
  owner: { name: string },
  grants: readonly { kind: AgentGrantKind; target: string; reason: string }[],
): SystemPhrase {
  return {
    subject: { kind: 'agent', id: agent.pubkey, name: agent.name },
    verb: `asked ${owner.name} for`,
    object: grants.map((grant) => `${grant.kind} ${grant.target}`).join(' and '),
    ...(grants.length === 1 && grants[0]!.reason ? { consequence: grants[0]!.reason } : {}),
  };
}

export const DAEMON_OPERATION_NAMES = new Set<keyof DaemonOperationMap>([
  'getDaemonBootstrap',
  'getWorkspaceRoster',
  'getRoomInbox',
  'getRoomConversation',
  'getRoomAuthority',
  'getPermissionAuthority',
  'getMissionAuthority',
  'listWorkSchedules',
  'getWorkScheduleAuthority',
  'listAgentToolSchedules',
  'createAgentSchedule',
  'listAgentSchedules',
  'deleteAgentSchedule',
  'getAgentToolMandate',
  'getTargetAgentAuthority',
  'listRoomCorners',
  'getCornerRestoreState',
  'getCornerCloseRequests',
  'listUntrackedCorners',
  'getRoomRepositoryState',
  'getRoomGitHubToken',
  'getRoomTargetBranch',
  'getIdentitySuccession',
  'getAgentConfiguration',
  'getAgentPresence',
  'getRequestCompletion',
  'postRoomMessage',
  'postAgentAttachment',
  'postAgentDraft',
  'postAgentThought',
  'retractAgentLiveOutput',
  'postAgentTurnReceipt',
  'postAgentActivity',
  'postPermissionRequest',
  'postPermissionExecution',
  'postWorkSchedule',
  'postWorkScheduleReceipt',
  'postAgentToolScheduleIndex',
  'postAgentToolMandate',
  'postAgentCommands',
  'postAgentPresence',
  'postAgentModelCatalog',
  'postCornerLifecycle',
  'postCornerRemoteState',
  'postCornerPlan',
  'postTargetBranchProposal',
  'requestAgentGrant',
  'listAgentGrants',
  'consumeAgentGrant',
  'createCorner',
  'archiveCorner',
  'ensureAgentMembership',
]);
