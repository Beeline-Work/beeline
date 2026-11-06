import { roomEventSubscriptions } from '../agent-subscriptions.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { scheduleDisplayTitle, validateScheduleTitle } from '../schedule-title.js';
import { setRoomEventSubscriptions } from '../agent-subscriptions.js';
import { authorizeCommandOutput } from '../agent-command.js';
import { randomUUID } from 'node:crypto';
import type { EventSubscriptionsResult } from '@beeline/api-contract/daemon';
import { MAX_EVENT_CONSEQUENCE_LENGTH, MAX_MENTIONS_PER_EVENT, SUBSCRIBABLE_EVENT_KINDS, isAgentKind, isPerItemEventKind, isServerEventKind, isSubscribableEventKind, perItemSubscriptionRefusal } from '@beeline/api-contract/phone';
import { nextScheduleOccurrence, validateScheduleCadence } from '../agent-schedules.js';
import { type SqlDatabase } from '../database.js';
import { systemLine } from '../system-line.js';
import { activeRunIdsForSchedule } from '../workflow-runs.js';
import { activeWorkflowRunIds, humanRoomAdmin, scheduleWorkflowName } from '../workflow-admin.js';
import type { DaemonContext } from './context.js';
import { Input, Output, id } from './values.js';
import { daemonWriteResult } from './corner-messages.js';


  /** Agent-driven schedules (beeline-agent create_schedule) run through the
   *  same agent_schedules loop as manager-created schedules, with the agent as
   *  both creator and beneficiary. */
  export async function daemonCreateAgentSchedule(ctx: DaemonContext, 
    input: Input<'createAgentSchedule'>,
    agentId: string,
    transaction?: SqlDatabase,
  ): Promise<Output<'createAgentSchedule'>> {
    if (!transaction)
      return ctx.database.transaction((db) => daemonCreateAgentSchedule(ctx, input, agentId, db));
    const db = transaction;
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
      throw new Error('schedule prompt is required');
    }
    const title = validateScheduleTitle(input.title);
    if (!title) throw new Error('title is required when creating a schedule');
    validateScheduleCadence(input.cadence);
    if (
      input.maxRuns !== undefined &&
      (!Number.isSafeInteger(input.maxRuns) || (input.maxRuns as number) < 1)
    ) {
      throw new Error('maxRuns must be a positive integer');
    }
    const room = await db.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM rooms WHERE id=$1`,
      [input.roomId],
    );
    if (!room.rows[0]) throw new Error('schedule room not found');
    const workflowName = await scheduleWorkflowName(
      db,
      input.roomId,
      input.prompt,
      input.workflowName,
    );
    const scheduleId = randomUUID();
    const nextRunAt = nextScheduleOccurrence(input.cadence, new Date());
    // The person whose message led to this schedule owns the workflow runs it
    // starts; never the hidden scheduler that posts an agent's own schedule.
    const requestId = (input as { requestId?: unknown }).requestId;
    const ownerId =
      typeof requestId === 'string'
        ? (
            await db.query<{ author_id: string }>(
              `SELECT root.author_id FROM agent_commands command
               JOIN messages root ON root.id=command.root_source_message_id
               JOIN identities person ON person.id=root.author_id AND person.kind='human'
                 AND NOT COALESCE(person.hidden_from_roster,false)
               WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3
               ORDER BY command.created_at DESC LIMIT 1`,
              [input.roomId, agentId, requestId],
            )
          ).rows[0]?.author_id
        : undefined;
    await db.query(
      `INSERT INTO agent_schedules(
         id,workspace_id,room_id,agent_id,creator_id,cadence,message,max_runs,next_run_at,workflow_slug,owner_id,title
       ) VALUES($1,$2,$3,$4,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
      [
        scheduleId,
        room.rows[0].workspace_id,
        input.roomId,
        agentId,
        JSON.stringify(input.cadence),
        input.prompt.trim(),
        input.maxRuns ?? null,
        nextRunAt,
        workflowName ?? null,
        ownerId ?? null,
        title ?? scheduleDisplayTitle({ workflow: workflowName, prompt: input.prompt }),
      ],
    );
    await daemonRecordScheduleAuthorization(ctx, db, scheduleId, input.roomId, agentId, requestId,
      (input as { generationId?: unknown }).generationId);
    return { scheduleId, nextRunAt: Math.floor(nextRunAt.getTime() / 1_000) };
  }

  export async function daemonRecordScheduleAuthorization(ctx: DaemonContext, 
    db: SqlDatabase, scheduleId: string, roomId: string, agentId: string, requestId: unknown, generationId: unknown,
  ): Promise<void> {
    // Only a server-validated human-rooted turn may authorize the saved task.
    // Nonhuman edits clear old authority, even if the task text is unchanged.
    let humanCommandMessageId: string | null = null;
    if (typeof requestId === 'string' && typeof generationId === 'string') {
      const command = await authorizeCommandOutput(db, roomId, agentId, requestId, generationId);
      const human = (await db.query<{ id: string }>(
        `SELECT root.id FROM messages root
         JOIN identities person ON person.id=root.author_id AND person.kind='human' AND NOT person.hidden_from_roster
         WHERE root.id=$1 AND root.deleted_at IS NULL`,
        [command.root_source_message_id],
      )).rows[0];
      humanCommandMessageId = human?.id ?? null;
    }
    await db.query(
      `UPDATE agent_schedules SET human_command_message_id=$2 WHERE id=$1`,
      [scheduleId, humanCommandMessageId],
    );
  }


  /**
   * What this agent reacts to in this Room, set by the agent itself.
   *
   * The whole point of an event subscription is that an agent asked to greet
   * newcomers can start greeting newcomers without a person editing a database
   * row for it. The write is scoped by construction: the daemon token names the
   * agent, `roomId` names the Room, `execute` has already refused a Room this
   * agent is not a member of, and the write touches exactly that Room
   * membership or sparse corner preference. Only server kinds may be subscribed to — an `agent:` kind is a
   * sentence some agent chose to say, and reacting to it is a mention, not a
   * subscription. A per-item kind (`PER_ITEM_EVENT_KINDS`) is refused outright:
   * its item's owner already wakes directly, with no subscription involved,
   * and a Room-wide subscription to it would wake the subscriber on every
   * OTHER agent's item forever — a standing hook, not a description of this
   * agent's own work.
   */
  export async function daemonSetEventSubscriptions(ctx: DaemonContext, input: Input<'setEventSubscriptions'>, agentId: string) {
    const requested = Array.isArray(input.kinds) ? input.kinds : [];
    const perItem = requested.filter(isPerItemEventKind);
    if (perItem.length) throw new Error(perItemSubscriptionRefusal(perItem[0]!));
    const unknown = requested.filter((kind) => !isSubscribableEventKind(kind));
    if (unknown.length) {
      throw new Error(
        `not an event kind you can subscribe to: ${unknown.join(', ')}. ` +
          `The kinds are ${SUBSCRIBABLE_EVENT_KINDS.join(', ')}.`,
      );
    }
    const kinds = [...new Set(requested)] as EventSubscriptionsResult['kinds'];
    return { kinds: await setRoomEventSubscriptions(ctx.database, input.roomId, agentId, kinds) };
  }

  export async function daemonListEventSubscriptions(ctx: DaemonContext, input: Input<'listEventSubscriptions'>, agentId: string) {
    const kinds = (await roomEventSubscriptions(ctx.database, input.roomId))
      .filter(row => row.agent_id === agentId).map(row => row.event).filter(isSubscribableEventKind);
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
  export async function daemonPostRoomEvent(ctx: DaemonContext, input: Input<'postRoomEvent'>, agentId: string) {
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
    let wakes = [...new Set(input.mentionAgentIds ?? [])];
    if (wakes.length > MAX_MENTIONS_PER_EVENT)
      throw new Error(`an event may wake at most ${MAX_MENTIONS_PER_EVENT} agents`);
    if (wakes.length) {
      const members = await ctx.database.query<{ identity_id: string; handle: string | null }>(
        `SELECT member.identity_id, identity.handle FROM memberships member
         JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
         WHERE member.room_id=$1 AND member.removed_at IS NULL`,
        [input.roomId],
      );
      const idsPresent = new Set(members.rows.map((row) => row.identity_id));
      const byHandle = new Map<string, string>();
      for (const member of members.rows) {
        const handle = member.handle?.trim().replace(/^@/, '').toLowerCase();
        if (handle) byHandle.set(handle, member.identity_id);
      }
      const resolved = new Set<string>();
      const missing: string[] = [];
      for (const wake of wakes) {
        const resolvedId = idsPresent.has(wake)
          ? wake
          : byHandle.get(wake.trim().replace(/^@/, '').toLowerCase());
        if (resolvedId) resolved.add(resolvedId);
        else missing.push(wake);
      }
      if (missing.length)
        throw new Error(`not an agent member of this Room: ${missing.join(', ')}`);
      wakes = [...resolved];
    }
    const active = await ctx.database.query<{ request_id: string }>(
      `SELECT request_id FROM agent_turns
       WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 AND status='working'
       ORDER BY created_at DESC LIMIT 1`,
      [input.roomId, agentId, input.requestId],
    );
    const causeId = active.rows[0]?.request_id;
    if (!causeId) throw new Error('invalid event: this agent has no turn running here');
    const self = await ctx.database.query<{ name: string }>(
      `SELECT COALESCE(NULLIF(name,''),$2::text) name FROM identities WHERE id=$1`,
      [agentId, systemMessage("daemon-service.an-agent")],
    );
    const line = await systemLine(ctx.database, {
      roomId: input.roomId,
      subject: { kind: 'agent', id: agentId, name: self.rows[0]?.name ?? systemMessage("daemon-service.an-agent") },
      verb: systemMessage("daemon-service.emitted"),
      object: input.kind.slice('agent:'.length),
      consequence,
      kind: input.kind,
      wakes,
      causeId,
      commandId: (
        await authorizeCommandOutput(
          ctx.database,
          input.roomId,
          agentId,
          input.requestId,
          input.generationId,
        )
      ).id,
    });
    return { id: line.id, createdAt: Math.floor(Date.now() / 1_000) };
  }

  /**
   * Self-only wake reads span every Room the agent belongs to, in any
   * Workspace, so the agent that created a schedule can find and edit it from
   * any chat. Legacy Room tools list the schedules an agent in this Room may
   * manage: every schedule that mentions it, and every schedule any agent
   * created for itself here. A schedule a person created for another agent
   * stays that person's.
   */
  export async function daemonListAgentSchedules(ctx: DaemonContext, input: Input<'listAgentSchedules'>, agentId: string) {
    const rows = await ctx.database.query<{
      id: string;
      title: string | null;
      workflow_slug: string | null;
      agent_id: string;
      agent_handle: string | null;
      room_id: string;
      room_name: string;
      cadence: import('@beeline/api-contract/phone').RoomScheduleCadence;
      message: string;
      max_runs: number | null;
      run_count: number;
      next_run_at: Date;
      paused_at: Date | null;
    }>(
      `SELECT schedule.title,schedule.workflow_slug,schedule.id,schedule.agent_id,agent.handle agent_handle,schedule.cadence,
         schedule.room_id,room.name room_name,
         schedule.message,schedule.max_runs,schedule.run_count,schedule.next_run_at,schedule.paused_at
       FROM agent_schedules schedule JOIN identities agent ON agent.id=schedule.agent_id
       JOIN rooms room ON room.id=schedule.room_id
       WHERE (schedule.room_id=$1 OR ($3::boolean AND EXISTS (
           SELECT 1 FROM memberships self_membership
           WHERE self_membership.room_id=schedule.room_id
             AND self_membership.identity_id=$2 AND self_membership.removed_at IS NULL)))

         AND (NOT $3::boolean OR schedule.agent_id=$2)
         AND (schedule.workflow_slug IS NOT NULL OR schedule.agent_id=$2 OR schedule.creator_id=schedule.agent_id)
       ORDER BY schedule.created_at,schedule.id`,
      [input.roomId, agentId, input.selfOnly === true],
    );
    const schedules = await Promise.all(
      rows.rows.map(async (row) => {
        const workflowRunIds = row.workflow_slug
          ? await activeWorkflowRunIds(ctx.database, row.room_id, row.workflow_slug, agentId)
          : [];
        const scheduleRunIds = await activeRunIdsForSchedule(ctx.database, row.room_id, row.id);
        const activeRunIds = [...new Set([...workflowRunIds, ...scheduleRunIds])];
        return {
          ...(row.workflow_slug ? { workflowName: row.workflow_slug } : {}),
          title: scheduleDisplayTitle({ title: row.title, workflow: row.workflow_slug, prompt: row.message }),
          scheduleId: row.id,
          ...(row.paused_at ? { paused: true } : {}),
          ...(input.selfOnly ? { roomId: row.room_id, roomName: row.room_name } : {}),
          agentId: row.agent_id,
          ...(row.agent_handle ? { agentHandle: row.agent_handle } : {}),
          prompt: row.message,
          cadence: row.cadence,
          ...(row.max_runs !== null ? { maxRuns: row.max_runs } : {}),
          runCount: row.run_count,
          nextRunAt: Math.floor(row.next_run_at.getTime() / 1_000),
          ...(row.workflow_slug || activeRunIds.length ? { activeRunIds } : {}),
        };
      }),
    );
    return { schedules };
  }

  /**
   * Editing or deleting a saved schedule is workspace-admin-only: the person
   * whose message started this agent turn must be a human Workspace admin of
   * the schedule's Room. A turn with no such person (a scheduled wake, or no
   * active command) is refused.
   */
  export async function daemonRequireScheduleAdmin(ctx: DaemonContext, 
    db: SqlDatabase,
    scheduleRoomId: string,
    input: { roomId: string; requestId?: unknown; generationId?: unknown },
    agentId: string,
  ) {
    const command = ctx.authorizedCommand ?? (
      typeof input.requestId === 'string' && typeof input.generationId === 'string'
        ? await authorizeCommandOutput(db, input.roomId, agentId, input.requestId, input.generationId)
        : undefined);
    const requester = command
      ? (await db.query<{ author_id: string }>(
          `SELECT author_id FROM messages WHERE id=$1 AND deleted_at IS NULL`,
          [command.root_source_message_id],
        )).rows[0]?.author_id
      : undefined;
    if (!requester || !(await humanRoomAdmin(db, scheduleRoomId, requester)))
      throw new Error('workspace admins only: only a workspace admin can change or delete a saved schedule');
  }

  export async function daemonDeleteAgentSchedule(ctx: DaemonContext, input: Input<'deleteAgentSchedule'>, agentId: string) {
    const target = (await ctx.database.query<{ room_id: string }>(
      `SELECT room_id FROM agent_schedules
       WHERE id=$1
         AND (room_id=$2 OR ($4::boolean AND EXISTS (
           SELECT 1 FROM memberships self_membership
           WHERE self_membership.room_id=agent_schedules.room_id
             AND self_membership.identity_id=$3 AND self_membership.removed_at IS NULL)))

         AND (agent_id=$3 OR creator_id=agent_id)
         AND (NOT $4::boolean OR agent_id=$3)`,
      [input.scheduleId, input.roomId, agentId, input.selfOnly === true],
    )).rows[0];
    if (!target) throw new Error('schedule not found');
    await daemonRequireScheduleAdmin(ctx, ctx.database, target.room_id, input, agentId);
    const deleted = await ctx.database.query(
      `DELETE FROM agent_schedules
       WHERE id=$1
         AND (room_id=$2 OR ($4::boolean AND EXISTS (
           SELECT 1 FROM memberships self_membership
           WHERE self_membership.room_id=agent_schedules.room_id
             AND self_membership.identity_id=$3 AND self_membership.removed_at IS NULL)))

         AND (agent_id=$3 OR creator_id=agent_id)
         AND (NOT $4::boolean OR agent_id=$3)`,
      [input.scheduleId, input.roomId, agentId, input.selfOnly === true],
    );
    if (!deleted.rowCount) throw new Error('schedule not found');
    return daemonWriteResult(ctx);
  }

  /**
   * Any agent in the Room may carry the edit of a schedule an agent created
   * for itself, but only for a human Workspace admin (`requireScheduleAdmin`).
   * Its runs are posted as the scheduler's line, never in a person's name, so
   * an edit cannot put words in anybody's mouth; a person's schedule is not
   * editable here.
   */
  export async function daemonUpdateAgentSchedule(ctx: DaemonContext, 
    input: Input<'updateAgentSchedule'>,
    agentId: string,
    transaction?: SqlDatabase,
  ): Promise<Output<'updateAgentSchedule'>> {
    if (!transaction)
      return ctx.database.transaction((db) => daemonUpdateAgentSchedule(ctx, input, agentId, db));
    const db = transaction;
    const title = validateScheduleTitle(input.title);
    if (
      input.prompt === undefined &&
      input.cadence === undefined &&
      input.maxRuns === undefined &&
      input.workflowName === undefined &&
      input.title === undefined
    )
      throw new Error('give a prompt, cadence, or maxRuns to change');
    if (input.prompt !== undefined && (typeof input.prompt !== 'string' || !input.prompt.trim()))
      throw new Error('schedule prompt is required');
    if (input.cadence !== undefined) validateScheduleCadence(input.cadence);
    if (
      input.maxRuns !== undefined &&
      (!Number.isSafeInteger(input.maxRuns) || (input.maxRuns as number) < 1)
    ) {
      throw new Error('maxRuns must be a positive integer');
    }
    const existing = (
      await db.query<{ message: string; workflow_slug: string | null; room_id: string }>(
        `SELECT message,workflow_slug,room_id FROM agent_schedules WHERE id=$1
           AND creator_id=agent_id
           AND (room_id=$2 OR ($4::boolean AND EXISTS (
             SELECT 1 FROM memberships self_membership
             WHERE self_membership.room_id=agent_schedules.room_id
               AND self_membership.identity_id=$3 AND self_membership.removed_at IS NULL)))

           AND (NOT $4::boolean OR agent_id=$3)`,
        [input.scheduleId, input.roomId, agentId, input.selfOnly === true],
      )
    ).rows[0];
    if (!existing) throw new Error('schedule not found');
    await daemonRequireScheduleAdmin(ctx, db, existing.room_id, input, agentId);
    const workflowName =
      (await scheduleWorkflowName(
        db,
        existing.room_id,
        input.prompt ?? existing.message,
        input.workflowName,
      )) ?? existing.workflow_slug;
    const nextRunAt =
      input.cadence === undefined ? null : nextScheduleOccurrence(input.cadence, new Date());
    // Keep the stored name in step with the prompt it now runs.
    const resolvedTitle =
      title ??
      (input.prompt === undefined
        ? undefined
        : scheduleDisplayTitle({ workflow: workflowName, prompt: input.prompt }));
    const updated = await db.query<{ next_run_at: Date }>(
      `UPDATE agent_schedules SET message=COALESCE($3,message),
         cadence=COALESCE($4::jsonb,cadence),max_runs=COALESCE($5,max_runs),
         next_run_at=COALESCE($6,next_run_at),updated_at=now(),workflow_slug=$7,updated_by=$8,title=COALESCE($10,title)
       WHERE id=$1 AND room_id=$2 AND creator_id=agent_id
         AND (NOT $9::boolean OR agent_id=$8)
       RETURNING next_run_at`,
      [
        input.scheduleId,
        existing.room_id,
        input.prompt?.trim() ?? null,
        input.cadence === undefined ? null : JSON.stringify(input.cadence),
        input.maxRuns ?? null,
        nextRunAt,
        workflowName ?? null,
        agentId,
        input.selfOnly === true,
        resolvedTitle ?? null,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw new Error('schedule not found');
    await daemonRecordScheduleAuthorization(ctx, db, input.scheduleId, input.roomId, agentId,
      (input as { requestId?: unknown }).requestId, (input as { generationId?: unknown }).generationId);
    return {
      scheduleId: input.scheduleId,
      nextRunAt: Math.floor(row.next_run_at.getTime() / 1_000),
    };
  }
