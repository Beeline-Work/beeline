import { flushStartupWakeBackoffs, startupWakeAllowedSql } from './startup-wake-backoff.js';
import { NotificationWork } from './notification-work.js';
import type { LiveHub } from './live.js';
import type { SqlDatabase } from './database.js';
import {
  expiredWakeDigestSources,
  lockAgentCommandQueue,
  readAgentCommands,
  type CommandRow,
} from './agent-command.js';

export async function lockCommanderWakes(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `commander-wakes:${roomId}:${agentId}`,
  ]);
}

async function lockWakeConsumer(db: SqlDatabase, roomId: string, agentId: string) {
  // Readers/claimers take the Stop queue lock before the wake lock. Dispatch
  // takes only the wake lock so orders arriving during Stop can still commit.
  await lockAgentCommandQueue(db, roomId, agentId);
  await lockCommanderWakes(db, roomId, agentId);
}

/** Caller holds the recipient queue lock, shared with command dispatch. */
async function flushCommanderWakes(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
  sourceIds?: readonly string[],
  ready = false,
): Promise<boolean> {
  const queued = (
    await db.query<{ id: string; from_room: string | null }>(
      `SELECT command.id,command.private_payload->>'fromRoomId' from_room
     FROM agent_commands command
     WHERE command.room_id=$1 AND command.agent_id=$2 AND command.state='pending'
       AND ${startupWakeAllowedSql('command')}
       AND (command.wake_after<=now() OR ($4::boolean AND command.wake_after IS NULL))
       AND ($3::text[] IS NULL OR command.id=ANY($3::text[]))
     ORDER BY command.inbox_sequence FOR UPDATE`,
      [roomId, agentId, sourceIds ?? null, ready],
    )
  ).rows;
  if (!queued.length) return false;
  // Use the same renderer as ordinary delivery, including subscription actions,
  // workflow hints, cards, attachments and resume context. Expired workflow
  // attempts are cancelled individually before choosing the digest's head.
  const rendered = (
    await readAgentCommands(
      db,
      roomId,
      agentId,
      queued.map((item) => item.id),
    )
  ).commands;
  const commands = new Map(rendered.map((command) => [command.id, command]));
  const valid = queued.filter((item) => commands.has(item.id));
  if (!valid.length) return false;
  const head = valid[0]!.id;
  const rest = valid.slice(1);
  const context = rest
    .map((item) => {
      const command = commands.get(item.id)!;
      return JSON.stringify({
        ...command,
        fromRoomId: item.from_room ?? roomId,
        authorId: command.source.authorId,
        body: command.source.body + (command.coalescedContext ? '\nAdditional inbox wakes in arrival order:\n' + command.coalescedContext : ''),
        attachments: command.source.attachments,
      });
    })
    .join('\n');
  const attachments = valid.flatMap((item) => commands.get(item.id)!.source.attachments);
  await db.query(
    `UPDATE agent_commands SET wake_after=NULL,
       coalesced_context=concat_ws(E'\n',NULLIF(coalesced_context,''),NULLIF($2,'')),
       coalesced_attachments=$3::jsonb
     WHERE id=$1 AND state='pending'`,
    [head, context, JSON.stringify(attachments)],
  );
  if (rest.length)
    await db.query(
      `UPDATE agent_commands SET state='cancelled',completed_at=now(),cancellation_reason=$2
     WHERE id=ANY($1::text[]) AND state='pending'`,
      [rest.map((item) => item.id), `coalesced_into:${head}`],
    );
  return true;
}

/** Rebuild only when a recorded source expired or was stopped. */
export async function refreshWakeDigests(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockWakeConsumer(tx, roomId, agentId);
    const heads = (
      await tx.query<{ id: string; coalesced_context: string }>(
        `SELECT id,coalesced_context FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND coalesced_context IS NOT NULL
       AND (state='pending' OR (state='claimed' AND lease_expires_at<=now())
         OR (state='cancelled' AND cancellation_reason IN ('workflow_attempt_expired','answered_report','source_deleted','stop')))
       ORDER BY inbox_sequence FOR UPDATE`,
        [roomId, agentId],
      )
    ).rows;
    for (const head of heads) {
      const recorded = head.coalesced_context
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).id)
        .filter((id): id is string => typeof id === 'string');
      const sources = (
        await tx.query<{ id: string; cancellation_reason: string | null }>(
          `SELECT id,cancellation_reason FROM agent_commands WHERE room_id=$1 AND agent_id=$2
         AND (id=$3 OR cancellation_reason='coalesced_into:'||$3 OR id=ANY($4::text[]))
         ORDER BY inbox_sequence FOR UPDATE`,
          [roomId, agentId, head.id, recorded],
        )
      ).rows;
      const ids = sources
        .filter((source) => source.cancellation_reason !== 'stop')
        .map((source) => source.id);
      if (
        ids.length === sources.length &&
        !(await expiredWakeDigestSources(tx, roomId, agentId, ids)).length
      )
        continue;
      // Restore the immutable original sources in this transaction, then apply
      // the normal expiry fence and digest just the surviving commands. A stale
      // cached head loses its claim; the replacement gets its own ordinary claim.
      await tx.query(
        'UPDATE agent_commands SET coalesced_context=NULL,coalesced_attachments=NULL WHERE id=$1',
        [head.id],
      );
      if (!ids.length) continue;
      await tx.query(
        `UPDATE agent_commands SET state='pending',completed_at=NULL,cancellation_reason=NULL,
          coalesced_context=NULL,coalesced_attachments=NULL,wake_after=now()
         WHERE id=ANY($1::text[])`,
        [ids],
      );
      await flushCommanderWakes(tx, roomId, agentId, ids);
    }
    await queueSteersBehindTurn(tx, roomId, agentId);
  });
}

/**
 * Queue and wake locks are held. Instructions that arrive during a working
 * turn wait behind it and join one inbox digest, so the next turn reads them
 * all in arrival order. Nothing here stops the running turn; only an explicit
 * Stop does.
 */
async function queueSteersBehindTurn(db: SqlDatabase, roomId: string, agentId: string): Promise<void> {
  const busy = (await db.query<Pick<CommandRow, 'wake_context'> & { claimed_at: Date }>(
    `SELECT command.claimed_at,command.wake_context FROM agent_commands command JOIN agent_turns turn
       ON turn.room_id=command.room_id AND turn.agent_id=command.agent_id
       AND turn.request_id=command.turn_request_id AND turn.generation_id=command.generation_id
     WHERE command.room_id=$1 AND command.agent_id=$2 AND command.state='claimed'
       AND command.action IN ('input','resume') AND turn.status='working'
     ORDER BY command.claimed_at DESC LIMIT 1`, [roomId, agentId])).rows[0];
  if (!busy) return;
  const pending = (await db.query<{ id: string }>(
    `SELECT command.id FROM agent_commands command
     WHERE command.room_id=$1 AND command.agent_id=$2 AND command.state='pending'
       AND command.action IN ('input','resume') AND command.wake_after IS NULL AND NOT command.avatar_job
       AND ${startupWakeAllowedSql('command')}
       AND command.created_offline IS DISTINCT FROM TRUE
       AND NOT (command.reason='corner_brief_revision' AND command.wake_context IS NOT NULL
         AND command.wake_context=$4::jsonb)
       AND (command.reason IN ('order','corner_brief_revision','human_tag','direct_message')
         OR EXISTS(SELECT 1 FROM agent_commands absorbed
           WHERE absorbed.cancellation_reason='coalesced_into:'||command.id
             AND absorbed.reason IN ('order','corner_brief_revision','human_tag','direct_message')))
       AND command.created_at>$3::timestamptz
     ORDER BY command.inbox_sequence FOR UPDATE`,
    [roomId, agentId, busy.claimed_at, JSON.stringify(busy.wake_context ?? null)])).rows;
  if (pending.length < 2) return;
  // Render through the same stale brief/head/workflow fences as delivery. A
  // duplicate snapshot, old revision or delayed inbox is never a new steer.
  const valid = (await readAgentCommands(db, roomId, agentId, pending.map(row => row.id))).commands;
  const ids = pending.map(row => row.id).filter(id => valid.some(command => command.id === id));
  if (ids.length < 2) return;
  await flushCommanderWakes(db, roomId, agentId, ids, true);
}

/** Durable deadlines are recovered on startup and serviced by the server's existing tick. */
export async function flushDueCommanderWakes(db: SqlDatabase): Promise<number> {
  await flushStartupWakeBackoffs(db);
  const recipients = (
    await db.query<{ room_id: string; agent_id: string }>(
      `SELECT DISTINCT command.room_id,command.agent_id FROM agent_commands command
     JOIN effective_memberships member ON member.room_id=command.room_id AND member.identity_id=command.agent_id
       AND member.removed_at IS NULL
     JOIN rooms room ON room.id=command.room_id AND room.archived_at IS NULL
     WHERE command.state='pending' AND command.wake_after<=now() LIMIT 100`,
    )
  ).rows;
  let flushed = 0;
  for (const recipient of recipients)
    await db.transaction(async (tx) => {
      await lockWakeConsumer(tx, recipient.room_id, recipient.agent_id);
      const membership = await tx.query(
        `SELECT 1 FROM effective_memberships member JOIN rooms room ON room.id=member.room_id
       WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL
         AND room.archived_at IS NULL`,
        [recipient.room_id, recipient.agent_id],
      );
      if (!membership.rowCount) return;
      const windows = (
        await tx.query<{ ids: string[] }>(
          `SELECT array_agg(id ORDER BY inbox_sequence) ids FROM agent_commands
       WHERE room_id=$1 AND agent_id=$2 AND state='pending' AND wake_after<=now()
       GROUP BY wake_after ORDER BY wake_after`,
          [recipient.room_id, recipient.agent_id],
        )
      ).rows;
      for (const window of windows)
        if (await flushCommanderWakes(tx, recipient.room_id, recipient.agent_id, window.ids))
          flushed++;
    });
  return flushed;
}

/** Durable wake windows use one timeout each; queue locks fence duplicate deliveries. */
export class CommanderWakeDeadlines {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly work = new NotificationWork(1);
  private readonly refreshing = new Map<string, { again: boolean; done: Promise<void> }>();
  private stopped = false;
  private release: () => void;
  private resync: () => void;
  constructor(
    private db: SqlDatabase,
    live: LiveHub,
    private report: (error: unknown) => void,
  ) {
    this.release = live.subscribeAll((event) => {
      if (
        event.type === 'invalidate' &&
        event.reason === 'postgres:agent_commands' &&
        event.targetAgentId
      )
        void this.refresh(event.roomId, event.targetAgentId).catch(report);
    });
    this.resync = live.subscribeResync(() => {
      void this.start().catch(report);
    });
  }
  async start(): Promise<void> {
    await flushDueCommanderWakes(this.db);
    const rows = (
      await this.db.query<{ room_id: string; agent_id: string }>(
        `SELECT DISTINCT room_id,agent_id FROM agent_commands WHERE state='pending' AND (wake_after IS NOT NULL OR startup_wake_after IS NOT NULL)`,
      )
    ).rows;
    for (const row of rows) await this.refresh(row.room_id, row.agent_id);
  }
  private refresh(roomId: string, agentId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const key = `${roomId}:${agentId}`;
    const existing = this.refreshing.get(key);
    if (existing) { existing.again = true; return existing.done; }
    const entry = { again: false, done: Promise.resolve() };
    this.refreshing.set(key, entry);
    entry.done = (async () => {
      do {
        entry.again = false;
        await this.work.run(() => this.refreshOnce(roomId, agentId));
      } while (entry.again && !this.stopped);
    })().finally(() => { this.refreshing.delete(key); });
    return entry.done;
  }

  private async refreshOnce(roomId: string, agentId: string): Promise<void> {
    if (this.stopped) return;
    const key = `${roomId}:${agentId}`;
    const row = (
      await this.db.query<{ due: Date | null }>(
        `SELECT min(GREATEST(command.wake_after,command.startup_wake_after)) due FROM agent_commands command
         JOIN rooms room ON room.id=command.room_id AND room.archived_at IS NULL
         JOIN effective_memberships member ON member.room_id=command.room_id AND member.identity_id=command.agent_id AND member.removed_at IS NULL
         WHERE command.room_id=$1 AND command.agent_id=$2 AND command.state='pending'
           AND isfinite(GREATEST(command.wake_after,command.startup_wake_after))`,
        [roomId, agentId],
      )
    ).rows[0];
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    this.timers.delete(key);
    if (!row?.due || this.stopped) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(key);
        void flushDueCommanderWakes(this.db)
          .then(() => this.refresh(roomId, agentId))
          .catch(this.report);
      },
      Math.max(1, new Date(row.due).getTime() - Date.now()),
    );
    timer.unref?.();
    this.timers.set(key, timer);
  }
  stop(): void {
    this.stopped = true;
    this.release();
    this.resync();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
