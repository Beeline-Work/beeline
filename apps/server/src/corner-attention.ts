import { createHash } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import {
  cornerWorkSql,
  cornerBlockerSql,
  cornerRowState,
  type CornerStateRow,
} from './chat-corner-counts.js';
import { commanderReportAddress, reportToCommander } from './commander.js';
import { cornerImplementerSql } from './corner-worker.js';
import { ensureSystemIdentity } from './system-line.js';

export const CORNER_ATTENTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS corner_attention_spans (
  corner_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0,
  last_state text,
  checked_at timestamptz
);
CREATE INDEX IF NOT EXISTS corner_attention_checked ON corner_attention_spans(checked_at);
CREATE TABLE IF NOT EXISTS corner_attention_flags (
  id text PRIMARY KEY,
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('idle','waiting')),
  revision bigint NOT NULL,
  item_id text,
  person_id text REFERENCES identities(id) ON DELETE CASCADE,
  due_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  dismissed_at timestamptz,
  reminder_id text,
  deliveries integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS corner_attention_flags_corner ON corner_attention_flags(corner_id);
CREATE INDEX IF NOT EXISTS corner_attention_flags_due ON corner_attention_flags(due_at)
  WHERE dismissed_at IS NULL AND (kind='waiting' OR sent_at IS NULL);

CREATE OR REPLACE FUNCTION corner_attention_dismiss_reminder() RETURNS trigger
LANGUAGE plpgsql AS $attention$
BEGIN
  UPDATE corner_attention_flags flag SET dismissed_at=COALESCE(flag.dismissed_at,NEW.cleared_at)
    FROM messages reminder WHERE reminder.id=NEW.message_id
      AND reminder.card->>'cornerReminderId'=flag.id AND flag.person_id=NEW.identity_id;
  RETURN NULL;
END
$attention$;
DROP TRIGGER IF EXISTS corner_attention_reminder_clear ON needs_you_marks;
CREATE TRIGGER corner_attention_reminder_clear AFTER INSERT OR UPDATE OF cleared_at ON needs_you_marks
  FOR EACH ROW WHEN (NEW.cleared_at IS NOT NULL)
  EXECUTE FUNCTION corner_attention_dismiss_reminder();

CREATE OR REPLACE FUNCTION corner_attention_new_work() RETURNS trigger
LANGUAGE plpgsql AS $attention$
BEGIN
  INSERT INTO corner_attention_spans(corner_id,revision)
  SELECT NEW.room_id,1 FROM rooms WHERE id=NEW.room_id AND parent_id IS NOT NULL
  ON CONFLICT(corner_id) DO UPDATE SET revision=corner_attention_spans.revision+1;
  RETURN NULL;
END
$attention$;
DROP TRIGGER IF EXISTS corner_attention_command ON agent_commands;
CREATE TRIGGER corner_attention_command AFTER INSERT ON agent_commands
  FOR EACH ROW EXECUTE FUNCTION corner_attention_new_work();
DROP TRIGGER IF EXISTS corner_attention_turn ON agent_turns;
CREATE TRIGGER corner_attention_turn AFTER INSERT ON agent_turns
  FOR EACH ROW EXECUTE FUNCTION corner_attention_new_work();
CREATE OR REPLACE FUNCTION corner_attention_push() RETURNS trigger
LANGUAGE plpgsql AS $attention$
BEGIN
  INSERT INTO corner_attention_spans(corner_id,revision) VALUES(NEW.corner_id,1)
  ON CONFLICT(corner_id) DO UPDATE SET revision=corner_attention_spans.revision+1;
  RETURN NULL;
END
$attention$;
DROP TRIGGER IF EXISTS corner_attention_head ON corner_facts;
DROP TRIGGER IF EXISTS corner_attention_open ON corner_facts;
CREATE TRIGGER corner_attention_open AFTER INSERT ON corner_facts
  FOR EACH ROW EXECUTE FUNCTION corner_attention_push();
CREATE TRIGGER corner_attention_head AFTER UPDATE OF lifecycle ON corner_facts
  FOR EACH ROW WHEN (OLD.lifecycle->'pr'->>'headSha' IS DISTINCT FROM NEW.lifecycle->'pr'->>'headSha')
  EXECUTE FUNCTION corner_attention_push();
INSERT INTO corner_attention_spans(corner_id)
  SELECT id FROM rooms WHERE parent_id IS NOT NULL AND archived_at IS NULL ON CONFLICT DO NOTHING;
`;

type Row = CornerStateRow & {
  id: string;
  name: string;
  worker: string;
  revision: string;
  last_state: string | null;
  worker_wait: boolean;
};
type Flag = {
  id: string;
  corner_id: string;
  kind: 'idle' | 'waiting';
  revision: string;
  item_id: string | null;
  person_id: string | null;
  deliveries: number;
};
const key = (...parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function attentionSql(where: string): string {
  const worker = cornerImplementerSql('f', 'c');
  return `SELECT c.id,c.name,c.archived_at,f.lifecycle,f.workflow_state,f.workflow_outcome,
    activity.worker_active,activity.reviewer_active,NULL::text latest_turn_status,
    blocker.item_id IS NOT NULL blocking,blocker.item_id waiting_item_id,
    blocker.person_id waiting_person_id,blocker.created_at waiting_since,${worker} worker,
    span.revision::text,span.last_state,
    (EXISTS(SELECT 1 FROM agent_schedules schedule WHERE schedule.room_id=c.id
      AND schedule.agent_id=${worker} AND (schedule.max_runs IS NULL OR schedule.run_count<schedule.max_runs))
    OR EXISTS(SELECT 1 FROM agent_subscriptions subscription WHERE subscription.room_id=c.id
      AND subscription.agent_id=${worker})
    OR EXISTS(SELECT 1 FROM corner_watches watch WHERE watch.watcher_room_id=c.id
      AND watch.agent_id=${worker} AND jsonb_array_length(watch.kinds)>0)
    OR EXISTS(SELECT 1 FROM memberships membership WHERE membership.room_id=c.id
      AND membership.identity_id=${worker} AND membership.removed_at IS NULL
      AND jsonb_array_length(membership.event_subscriptions)>0)) worker_wait
    FROM rooms c JOIN corner_facts f ON f.corner_id=c.id
    ${cornerWorkSql()} ${cornerBlockerSql()}
    JOIN corner_attention_spans span ON span.corner_id=c.id
    WHERE c.parent_id IS NOT NULL AND c.archived_at IS NULL AND ${where}`;
}

/** Record flags before delivery. Bounded, oldest-checked-first pages cover all open corners. */
export async function recordCornerAttention(db: SqlDatabase): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = (
      await tx.query<Row>(
        attentionSql('true') +
          ' ORDER BY span.checked_at NULLS FIRST,c.id LIMIT 100 FOR UPDATE OF span SKIP LOCKED',
      )
    ).rows;
    for (const row of rows) {
      const state = cornerRowState(row).state;
      const revision =
        BigInt(row.revision) +
        (row.last_state && row.last_state !== 'idle' && state === 'idle' ? 1n : 0n);
      await tx.query(
        `UPDATE corner_attention_spans SET revision=$2,last_state=$3,checked_at=now() WHERE corner_id=$1`,
        [row.id, revision.toString(), state],
      );
      if (state === 'idle' && !row.worker_wait) {
        await tx.query(
          `INSERT INTO corner_attention_flags(id,corner_id,kind,revision)
          VALUES($1,$2,'idle',$3) ON CONFLICT DO NOTHING`,
          [key('idle', row.id, revision.toString()), row.id, revision.toString()],
        );
      } else if (
        state === 'waiting' &&
        row.waiting_item_id &&
        row.waiting_person_id &&
        row.waiting_since
      ) {
        await tx.query(
          `INSERT INTO corner_attention_flags(id,corner_id,kind,revision,item_id,person_id,due_at)
          VALUES($1,$2,'waiting',$3,$4,$5,$6::timestamptz+interval '24 hours') ON CONFLICT DO NOTHING`,
          [
            key('waiting', row.id, row.waiting_item_id, row.waiting_person_id),
            row.id,
            revision.toString(),
            row.waiting_item_id,
            row.waiting_person_id,
            row.waiting_since,
          ],
        );
      }
    }
  });
}

/** Delivery and its receipt commit together; deterministic ids retry a pending flag after a crash. */
export async function deliverCornerAttention(db: SqlDatabase): Promise<void> {
  const flags = (
    await db.query<Flag>(`SELECT * FROM corner_attention_flags
    WHERE dismissed_at IS NULL AND due_at<=now() AND (kind='waiting' OR sent_at IS NULL)
    ORDER BY due_at,id LIMIT 100`)
  ).rows;
  for (const flag of flags)
    await db.transaction(async (tx) => {
      const row = (
        await tx.query<Row>(attentionSql('c.id=$1') + ' FOR UPDATE OF span', [flag.corner_id])
      ).rows[0];
      const claimed = await tx.query<Flag>(
        `SELECT * FROM corner_attention_flags WHERE id=$1
      AND dismissed_at IS NULL AND due_at<=now() AND (kind='waiting' OR sent_at IS NULL) FOR UPDATE SKIP LOCKED`,
        [flag.id],
      );
      if (!claimed.rowCount) return;
      const current = claimed.rows[0]!;
      if (!row) {
        await tx.query('UPDATE corner_attention_flags SET dismissed_at=now() WHERE id=$1', [
          flag.id,
        ]);
        return;
      }
      const state = cornerRowState(row).state;
      if (flag.kind === 'idle') {
        if (row.revision !== String(flag.revision) || state !== 'idle') {
          await tx.query('UPDATE corner_attention_flags SET dismissed_at=now() WHERE id=$1', [
            flag.id,
          ]);
          return;
        }
        if (row.worker_wait) {
          await tx.query(
            `UPDATE corner_attention_flags SET due_at=now()+interval '5 seconds' WHERE id=$1`,
            [flag.id],
          );
          return;
        }
        const address = await commanderReportAddress(tx, row.id);
        if (!address.recipient || !address.returnRoom) return;
        const delivered = await reportToCommander(
          tx,
          row.id,
          SYSTEM_IDENTITY_ID,
          `blocked: Corner ${row.name} is idle with no worker schedule or event subscription. Resume, schedule or close it.`,
          undefined,
          flag.id,
          { automatic: true },
        );
        if ('delivered' in delivered && delivered.delivered === false) return;
        await tx.query('UPDATE corner_attention_flags SET sent_at=now() WHERE id=$1', [flag.id]);
      } else {
        if (state === 'archived') {
          await tx.query('UPDATE corner_attention_flags SET dismissed_at=now() WHERE id=$1', [
            flag.id,
          ]);
          return;
        }
        if (row.waiting_item_id !== flag.item_id || row.waiting_person_id !== flag.person_id) {
          await tx.query('UPDATE corner_attention_flags SET dismissed_at=now() WHERE id=$1', [
            flag.id,
          ]);
          return;
        }
        if (state !== 'waiting') {
          await tx.query(
            `UPDATE corner_attention_flags SET due_at=now()+interval '5 seconds' WHERE id=$1`,
            [flag.id],
          );
          return;
        }
        const person = (
          await tx.query<{ handle: string }>(
            `SELECT handle FROM identities WHERE id=$1 AND kind='human'`,
            [flag.person_id],
          )
        ).rows[0];
        if (!person?.handle) return;
        await ensureSystemIdentity(tx);
        const reminderId = key(flag.id, current.deliveries);
        await tx.query(
          `INSERT INTO messages(id,room_id,author_id,text,presentation,card)
        VALUES($1,$2,$3,$4,'message',$5::jsonb) ON CONFLICT DO NOTHING`,
          [
            reminderId,
            row.id,
            SYSTEM_IDENTITY_ID,
            `@${person.handle} Please resolve the waiting request in ${row.name}. Dismiss this reminder in Needs you to stop daily reminders.`,
            JSON.stringify({ cornerReminderId: flag.id }),
          ],
        );
        await tx.query(
          `UPDATE corner_attention_flags SET sent_at=now(),due_at=now()+interval '24 hours',
        reminder_id=$2,deliveries=deliveries+1 WHERE id=$1`,
          [flag.id, reminderId],
        );
      }
    });
}

export async function runCornerAttention(db: SqlDatabase): Promise<void> {
  await recordCornerAttention(db);
  await deliverCornerAttention(db);
}
