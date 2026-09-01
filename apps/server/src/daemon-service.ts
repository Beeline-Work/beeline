import { randomBytes, randomUUID } from 'node:crypto';
import type { DaemonAttachment, DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';

type Input<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['input'];
type Output<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['output'];
const id = () => randomBytes(32).toString('hex');
const seconds = (date: Date) => Math.floor(date.getTime() / 1_000);

export class DaemonService {
  constructor(
    private readonly database: SqlDatabase,
    private readonly live: LiveHub,
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
    switch (name) {
      case 'getDaemonBootstrap':
        return (await this.bootstrap(authenticatedAgentId)) as Output<Name>;
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
  private async inbox(name: string, input: Input<'getRoomInbox'>, agentId: string) {
    const roomId =
      name === 'getCornerCloseRequests'
        ? (input as unknown as { cornerId: string }).cornerId
        : input.roomId;
    await this.access(roomId, agentId);
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
    }>(
      `SELECT id,author_id,created_at,presentation,text,mention_ids,reply_to_message_id,
        root_message_id,request_id,attachments,
        floor(extract(epoch FROM created_at)*1000)::bigint cursor_ms
        FROM messages WHERE room_id=$1 ${after ? 'AND (floor(extract(epoch FROM created_at)*1000)::bigint,id)>($2::bigint,$3)' : ''}
        ORDER BY cursor_ms,id LIMIT ${limit + 1}`,
      after ? [roomId, after[1], after[2]] : [roomId],
    );
    const page = rows.rows.slice(0, limit);
    return {
      items: page.map((row) => ({
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
      })),
      ...(page.at(-1) ? { cursor: `${page.at(-1)!.cursor_ms},${page.at(-1)!.id}` } : {}),
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
      `SELECT r.id,r.parent_id,(SELECT identity_id FROM memberships WHERE room_id=r.id AND role='owner' LIMIT 1)created_by,r.archived_at IS NOT NULL archived FROM rooms r WHERE parent_id=$1`,
      [roomId],
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
      }>(`SELECT feature_branch,request_id,close_requested FROM corner_facts WHERE corner_id=$1`, [
        cornerId,
      ])
    ).rows[0];
    return {
      cornerId,
      ...(row?.feature_branch ? { featureBranch: row.feature_branch } : {}),
      ...(row?.request_id ? { requestId: row.request_id } : {}),
      closeRequested: row?.close_requested ?? false,
    };
  }
  private async repository(roomId: string, agentId: string) {
    await this.access(roomId, agentId);
    const row = (
      await this.database.query<{
        repository_key: string | null;
        repository_remote: string | null;
        repository_target_branch: string;
      }>(
        `SELECT repository_key,repository_remote,repository_target_branch FROM rooms WHERE id=$1`,
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
      : { resolution: 'none' as const };
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
      }>(`SELECT soul,selected_model,selected_effort,commands FROM agents WHERE agent_id=$1`, [
        agentId,
      ])
    ).rows[0];
    return {
      ...(row?.soul ? { soul: { name: row.soul.name, instructions: row.soul.instructions } } : {}),
      ...(row?.selected_model ? { model: row.selected_model } : {}),
      ...(row?.selected_effort ? { effort: row.selected_effort } : {}),
      commands: row?.commands ?? [],
    };
  }
  private async presence(input: Input<'getAgentPresence'>, agentId: string) {
    const row = (
      await this.database.query<{
        body: { status: 'online' | 'offline'; observedAt: number };
        updated_at: Date;
      }>(
        `SELECT body,updated_at FROM live_outputs WHERE room_id=$1 AND agent_id=$2 AND kind='presence' ORDER BY updated_at DESC LIMIT 1`,
        [input.roomId, agentId],
      )
    ).rows[0];
    return row
      ? { status: row.body.status, observedAt: row.body.observedAt }
      : { status: 'dormant' as const };
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
    await this.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,request_id,legacy_event) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        messageId,
        input.roomId,
        agentId,
        input.text,
        input.presentation ?? 'message',
        input.requestId ?? null,
        JSON.stringify(input.tags ?? {}),
      ],
    );
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'message' });
    return { id: messageId, createdAt: Math.floor(Date.now() / 1000) };
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
    await this.database.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET status=EXCLUDED.status,generation_id=EXCLUDED.generation_id,created_at=now()`,
      [input.roomId, input.requestId, agentId, input.status, input.generationId ?? null],
    );
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'turn' });
    return this.writeResult();
  }
  private async activity(input: Input<'postAgentActivity'>, agentId: string) {
    await this.access(input.roomId, agentId);
    const messageId = id();
    await this.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,request_id,activity) VALUES($1,$2,$3,'','activity',$4,$5::jsonb)`,
      [messageId, input.roomId, agentId, input.requestId, JSON.stringify(input.activity)],
    );
    this.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'activity' });
    return { id: messageId, createdAt: Math.floor(Date.now() / 1000) };
  }
  private async permissionRequest(input: Input<'postPermissionRequest'>, agentId: string) {
    await this.access(input.roomId, agentId);
    await this.database.query(
      `INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status) VALUES($1,$2,$3,$4,$5::jsonb,'pending') ON CONFLICT(permission_id) DO NOTHING`,
      [
        input.permissionId,
        input.roomId,
        input.principalId,
        input.requestId,
        JSON.stringify(input.scope),
      ],
    );
    return this.writeResult();
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
      [input.roomId, agentId, JSON.stringify({ status: input.status, observedAt })],
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
      `INSERT INTO corner_facts(corner_id,objective,lifecycle) VALUES($1,$2,$3::jsonb) ON CONFLICT(corner_id) DO UPDATE SET objective=EXCLUDED.objective,lifecycle=corner_facts.lifecycle||EXCLUDED.lifecycle,updated_at=now()`,
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
      `INSERT INTO corner_facts(corner_id,feature_branch,lifecycle) VALUES($1,$2,$3::jsonb) ON CONFLICT(corner_id) DO UPDATE SET feature_branch=EXCLUDED.feature_branch,lifecycle=EXCLUDED.lifecycle,updated_at=now()`,
      [input.cornerId, input.branch, JSON.stringify(lifecycle)],
    );
    return this.writeResult();
  }
  private async cornerPlan(input: Input<'postCornerPlan'>, agentId: string) {
    await this.access(input.cornerId, agentId);
    const plan = { ...(input.objective ? { objective: input.objective } : {}), items: input.items };
    await this.database.query(
      `INSERT INTO corner_facts(corner_id,objective,plan) VALUES($1,$2,$3::jsonb) ON CONFLICT(corner_id) DO UPDATE SET objective=COALESCE(NULLIF(EXCLUDED.objective,''),corner_facts.objective),plan=EXCLUDED.plan,updated_at=now()`,
      [input.cornerId, input.objective ?? '', JSON.stringify(plan)],
    );
    return this.writeResult();
  }
  private async targetProposal(input: Input<'postTargetBranchProposal'>, agentId: string) {
    await this.access(input.roomId, agentId);
    const messageId = id();
    const agent = await this.identity(agentId);
    await this.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,request_id,card_type,card) VALUES($1,$2,$3,'','card',$4,'target-branch',$5::jsonb)`,
      [
        messageId,
        input.roomId,
        agentId,
        input.requestId,
        JSON.stringify({
          proposalId: messageId,
          from: input.from,
          to: input.to,
          repository: input.repository,
          agent,
        }),
      ],
    );
    return { id: messageId, createdAt: Math.floor(Date.now() / 1000) };
  }
  private async createCorner(input: Input<'createCorner'>, agentId: string) {
    await this.access(input.roomId, agentId);
    const parent = (
      await this.database.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM rooms WHERE id=$1`,
        [input.roomId],
      )
    ).rows[0]!;
    const cornerId = randomUUID();
    await this.database.transaction(async (db) => {
      await db.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,repository_key,repository_target_branch) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          cornerId,
          parent.workspace_id,
          input.roomId,
          agentId,
          input.name,
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
        `INSERT INTO corner_facts(corner_id,objective,request_id,lifecycle) VALUES($1,$2,$3,'{"lifecycle":"working","checks":"unknown"}')`,
        [cornerId, input.task, input.requestId],
      );
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
  private writeResult() {
    return { id: id(), createdAt: Math.floor(Date.now() / 1000) };
  }
}

export const DAEMON_OPERATION_NAMES = new Set<keyof DaemonOperationMap>([
  'getDaemonBootstrap',
  'getRoomInbox',
  'getRoomConversation',
  'getRoomAuthority',
  'getPermissionAuthority',
  'getMissionAuthority',
  'listWorkSchedules',
  'getWorkScheduleAuthority',
  'listAgentToolSchedules',
  'getAgentToolMandate',
  'getTargetAgentAuthority',
  'listRoomCorners',
  'getCornerRestoreState',
  'getCornerCloseRequests',
  'listUntrackedCorners',
  'getRoomRepositoryState',
  'getRoomTargetBranch',
  'getIdentitySuccession',
  'getAgentConfiguration',
  'getAgentPresence',
  'getRequestCompletion',
  'postRoomMessage',
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
  'createCorner',
  'archiveCorner',
  'ensureAgentMembership',
]);
