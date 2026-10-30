import { createHash } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import {
  cornerWorkSql,
  cornerBlockerSql,
  cornerRowState,
  cornerScheduledWaitSql,
  type CornerStateRow,
} from './chat-corner-counts.js';
import { reportToCommander } from './commander.js';

export const CORNER_ATTENTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS corner_attention_spans (
  corner_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0,
  last_state text,
  episode bigint NOT NULL DEFAULT 0,
  checked_at timestamptz
);
ALTER TABLE corner_attention_spans ADD COLUMN IF NOT EXISTS episode bigint NOT NULL DEFAULT 0;
UPDATE corner_attention_spans SET episode=revision WHERE episode=0 AND last_state='idle';
ALTER TABLE corner_attention_spans ADD COLUMN IF NOT EXISTS reported_episode bigint;
UPDATE corner_attention_spans SET reported_episode=episode WHERE reported_episode IS NULL;
ALTER TABLE corner_attention_spans ALTER COLUMN reported_episode SET DEFAULT 0;
ALTER TABLE corner_attention_spans ALTER COLUMN reported_episode SET NOT NULL;
CREATE INDEX IF NOT EXISTS corner_attention_checked ON corner_attention_spans(checked_at);
ALTER TABLE needs_you_marks ADD COLUMN IF NOT EXISTS reminder_dismissed_at timestamptz;
-- Retire the repeating attention/reminder machinery without deleting historical messages.
DROP TRIGGER IF EXISTS corner_attention_command ON agent_commands;
DROP TRIGGER IF EXISTS corner_attention_turn ON agent_turns;
DROP TRIGGER IF EXISTS corner_attention_reminder_clear ON needs_you_marks;
DROP FUNCTION IF EXISTS corner_attention_new_work();
DROP FUNCTION IF EXISTS corner_attention_dismiss_reminder();
-- Historical flags remain readable during rolling upgrades; new servers never sweep them.

CREATE OR REPLACE FUNCTION corner_attention_push() RETURNS trigger
LANGUAGE plpgsql AS $attention$
BEGIN
  INSERT INTO corner_attention_spans(corner_id,revision) VALUES(NEW.corner_id,1)
  ON CONFLICT(corner_id) DO UPDATE SET revision=corner_attention_spans.revision+1,last_state=NULL;
  RETURN NULL;
END
$attention$;
DROP TRIGGER IF EXISTS corner_attention_head ON corner_facts;
DROP TRIGGER IF EXISTS corner_attention_open ON corner_facts;
CREATE TRIGGER corner_attention_open AFTER INSERT ON corner_facts
  FOR EACH ROW EXECUTE FUNCTION corner_attention_push();
CREATE TRIGGER corner_attention_head AFTER UPDATE OF lifecycle ON corner_facts
  FOR EACH ROW WHEN (OLD.lifecycle->'pr'->>'headSha' IS DISTINCT FROM NEW.lifecycle->'pr'->>'headSha'
    OR COALESCE(OLD.lifecycle->'checksSummary'->>'status',OLD.lifecycle->>'checks')
      IS DISTINCT FROM COALESCE(NEW.lifecycle->'checksSummary'->>'status',NEW.lifecycle->>'checks'))
  EXECUTE FUNCTION corner_attention_push();
INSERT INTO corner_attention_spans(corner_id)
  SELECT id FROM rooms WHERE parent_id IS NOT NULL AND archived_at IS NULL ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION corner_attention_human() RETURNS trigger LANGUAGE plpgsql AS $human$
BEGIN
  IF NEW.presentation='message' AND NEW.system_event IS NULL
    AND NEW.author_id<>'${SYSTEM_IDENTITY_ID}'
    AND EXISTS(SELECT 1 FROM identities WHERE id=NEW.author_id AND kind='human') THEN
    UPDATE corner_attention_spans SET last_state=NULL,last_turn_ended_at=NULL WHERE corner_id=NEW.room_id;
    IF FOUND THEN
      PERFORM pg_notify('beeline_live_v1',json_build_object('table','corner_state','operation','UPDATE','roomId',NEW.room_id)::text);
    END IF;
  END IF;
  RETURN NULL;
END $human$;
DROP TRIGGER IF EXISTS corner_attention_human ON messages;
CREATE TRIGGER corner_attention_human AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION corner_attention_human();

ALTER TABLE corner_attention_spans ADD COLUMN IF NOT EXISTS last_turn_ended_at timestamptz;
ALTER TABLE corner_attention_spans ADD COLUMN IF NOT EXISTS ci_started_at timestamptz;
ALTER TABLE corner_attention_spans ADD COLUMN IF NOT EXISTS ci_head text;
CREATE OR REPLACE FUNCTION corner_state_changed() RETURNS trigger LANGUAGE plpgsql AS $state$
DECLARE corner uuid; pending boolean; failing boolean; was_failing boolean; same_head boolean; head text; status text;
BEGIN
  IF TG_TABLE_NAME='agent_turns' THEN
    corner=COALESCE(NEW.room_id,OLD.room_id);
    -- A commander answering its own alert is not new corner work.
    IF EXISTS(SELECT 1 FROM rooms WHERE id=corner AND created_by=COALESCE(NEW.agent_id,OLD.agent_id)) THEN
      RETURN NULL;
    END IF;
    IF NEW.status='working' THEN
      UPDATE corner_attention_spans SET last_state=NULL WHERE corner_id=corner;
    END IF;
    IF TG_OP='INSERT' AND NEW.status='working' AND NEW.generation_id LIKE 'pending:%' THEN
      UPDATE corner_attention_spans SET last_turn_ended_at=NEW.created_at WHERE corner_id=corner;
    END IF;
    IF NEW.status='failed' THEN
      UPDATE corner_attention_spans SET last_turn_ended_at=NULL WHERE corner_id=corner;
    ELSIF TG_OP='UPDATE' AND OLD.status='working' AND NEW.status<>'working'
      AND COALESCE(OLD.generation_id,'') NOT LIKE 'pending:%' THEN
      UPDATE corner_attention_spans SET last_turn_ended_at=CASE
        WHEN EXISTS(SELECT 1 FROM corner_report_blockers WHERE corner_id=corner)
          OR EXISTS(SELECT 1 FROM corner_merge_holds WHERE corner_id=corner AND released_at IS NULL)
          OR EXISTS(SELECT 1 FROM corner_owed owed JOIN messages report ON report.id=owed.message_id
            WHERE owed.corner_id=corner AND owed.blocking AND report.card->>'reportToId' IS NOT NULL
              AND (owed.expires_at IS NULL OR owed.expires_at>now())) THEN NULL
        ELSE clock_timestamp() END WHERE corner_id=corner;
    END IF;
  ELSIF TG_TABLE_NAME='agent_schedules' THEN
    corner=COALESCE(NEW.room_id,OLD.room_id);
  ELSE
    corner=COALESCE(NEW.corner_id,OLD.corner_id);
  END IF;
  -- An explicit wait ends the work stretch. Answering it must not revive
  -- the previous turn's grace period as if work had resumed.
  IF TG_TABLE_NAME IN ('corner_report_blockers','corner_merge_holds') THEN
    UPDATE corner_attention_spans SET last_turn_ended_at=NULL WHERE corner_id=corner;
  END IF;
  IF TG_TABLE_NAME='corner_facts' AND TG_OP<>'DELETE' THEN
    head=NEW.lifecycle->'pr'->>'headSha';
    status=COALESCE(NEW.lifecycle->'checksSummary'->>'status',NEW.lifecycle->>'checks');
    pending=status='pending'
      OR (head IS NOT NULL AND NEW.lifecycle->'checksSummary'->>'status'='unknown'
        AND NEW.lifecycle->'checksSummary'->>'fetchStartedAt' IS NULL);
    failing=status='failing';
    was_failing=TG_OP='UPDATE' AND COALESCE(OLD.lifecycle->'checksSummary'->>'status',OLD.lifecycle->>'checks')='failing';
    same_head=TG_OP='UPDATE' AND OLD.lifecycle->'pr'->>'headSha' IS NOT DISTINCT FROM head;
    UPDATE corner_attention_spans SET
      ci_started_at=CASE
        WHEN pending THEN CASE WHEN ci_head IS DISTINCT FROM head OR ci_started_at IS NULL
          THEN clock_timestamp() ELSE ci_started_at END
        WHEN failing THEN CASE WHEN was_failing AND same_head AND ci_started_at IS NOT NULL
          THEN ci_started_at ELSE clock_timestamp() END
        ELSE NULL END,ci_head=head WHERE corner_id=corner;
  END IF;
  IF EXISTS(SELECT 1 FROM rooms WHERE id=corner AND parent_id IS NOT NULL) THEN
    PERFORM pg_notify('beeline_live_v1',json_build_object('table','corner_state','operation','UPDATE','roomId',corner)::text);
  END IF;
  RETURN NULL;
END $state$;
DROP TRIGGER IF EXISTS corner_state_turn ON agent_turns;
CREATE TRIGGER corner_state_turn AFTER INSERT OR UPDATE OF status OR DELETE ON agent_turns
 FOR EACH ROW EXECUTE FUNCTION corner_state_changed();
DROP TRIGGER IF EXISTS corner_state_facts ON corner_facts;
CREATE TRIGGER corner_state_facts AFTER INSERT OR UPDATE OF lifecycle ON corner_facts
 FOR EACH ROW EXECUTE FUNCTION corner_state_changed();
DROP TRIGGER IF EXISTS corner_state_report ON corner_report_blockers;
CREATE TRIGGER corner_state_report AFTER INSERT OR UPDATE OR DELETE ON corner_report_blockers
 FOR EACH ROW EXECUTE FUNCTION corner_state_changed();
DROP TRIGGER IF EXISTS corner_state_hold ON corner_merge_holds;
CREATE TRIGGER corner_state_hold AFTER INSERT OR UPDATE OR DELETE ON corner_merge_holds
 FOR EACH ROW EXECUTE FUNCTION corner_state_changed();
DROP TRIGGER IF EXISTS corner_state_owed ON corner_owed;
CREATE TRIGGER corner_state_owed AFTER INSERT OR UPDATE OR DELETE ON corner_owed
 FOR EACH ROW EXECUTE FUNCTION corner_state_changed();
DROP TRIGGER IF EXISTS corner_state_schedule ON agent_schedules;
CREATE TRIGGER corner_state_schedule AFTER INSERT OR UPDATE OR DELETE ON agent_schedules
 FOR EACH ROW EXECUTE FUNCTION corner_state_changed();
-- Preserve pending heads during the first deployment; subsequent migrations never reset their clock.
UPDATE corner_attention_spans span SET ci_head=f.lifecycle->'pr'->>'headSha',
 ci_started_at=to_timestamp(COALESCE((f.lifecycle->'checksSummary'->>'updatedAt')::double precision,extract(epoch FROM now())))
 FROM corner_facts f WHERE f.corner_id=span.corner_id AND span.ci_started_at IS NULL
 AND (COALESCE(f.lifecycle->'checksSummary'->>'status',f.lifecycle->>'checks')='pending'
   OR (f.lifecycle->'pr'->>'headSha' IS NOT NULL AND f.lifecycle->'checksSummary'->>'status'='unknown'
     AND f.lifecycle->'checksSummary'->>'fetchStartedAt' IS NULL));
`;

type Row = CornerStateRow & {
  id: string;
  name: string;
  parent_id: string;
  last_state: string | null;
  episode: string;
  reported_episode: string;
  scheduled_wait: boolean;
  held: boolean;
  review_queued: boolean;
};
function attentionSql() {
  return `SELECT c.id,c.name,c.parent_id,c.archived_at,f.lifecycle,f.workflow_state,f.workflow_outcome,
    f.locked,activity.worker_active,activity.reviewer_active,NULL::text latest_turn_status,
    blocker.item_id IS NOT NULL blocking,blocker.item_id waiting_item_id,
    blocker.reason waiting_reason,blocker.kind waiting_kind,blocker.person_id waiting_person_id,
    span.last_turn_ended_at,span.ci_started_at,span.last_state,span.episode::text,span.reported_episode::text,
    EXISTS(SELECT 1 FROM corner_merge_holds WHERE corner_id=c.id AND released_at IS NULL) held,
    EXISTS(SELECT 1 FROM agent_commands command WHERE command.room_id=c.id
      AND command.action='input' AND (command.state='pending' OR
        (command.state='claimed' AND command.lease_expires_at>now()))
      AND command.review_context->>'headSha'=f.lifecycle->'pr'->>'headSha'
      AND command.review_context->>'purpose' IS NULL
      AND command.agent_id IS DISTINCT FROM f.worker_agent_id) review_queued,
    ${cornerScheduledWaitSql('c')} scheduled_wait
    FROM rooms c JOIN corner_facts f ON f.corner_id=c.id
    JOIN corner_attention_spans span ON span.corner_id=c.id
    ${cornerWorkSql(true)} ${cornerBlockerSql()}
    WHERE c.id=$1 AND c.archived_at IS NULL FOR UPDATE OF span`;
}

/** The span lock claims each transition across server instances. Delivery commits with it. */
export async function refreshCornerAttention(
  db: SqlDatabase,
  cornerId: string,
): Promise<{ parentId: string; deadlines: number[] } | undefined> {
  return db.transaction(async (tx) => {
    const row = (await tx.query<Row>(attentionSql(), [cornerId])).rows[0];
    if (!row) return;
    const checks = row.lifecycle?.checksSummary?.status ?? row.lifecycle?.checks;
    // Pending CI and standing scheduled waits are not idle-alert episodes.
    // Ending a wait can open a real episode.
    const summary = row.lifecycle?.checksSummary;
    const pendingHead = Boolean(row.lifecycle?.pr) && (checks === 'pending' || row.lifecycle?.checks === 'pending' ||
      (summary?.status === 'unknown' && summary.total === 0 && summary.fetchStartedAt === undefined));
    const suppressed = row.scheduled_wait || row.held || row.review_queued || pendingHead || row.worker_active || row.reviewer_active;
    if (suppressed) {
      await tx.query('UPDATE corner_attention_spans SET last_state=NULL,checked_at=now() WHERE corner_id=$1', [cornerId]);
      return { parentId: row.parent_id, deadlines: [] };
    }
    // The display reads idle as soon as a turn ends. The alert still waits out
    // the post-turn gap, so a reply or new order inside it opens no episode.
    const derived = cornerRowState(row).state;
    const inGap = derived === 'idle' && row.last_turn_ended_at !== null && row.last_turn_ended_at !== undefined &&
      Date.now() - new Date(row.last_turn_ended_at).getTime() < 30_000;
    const state = inGap ? 'working' : derived;
    const episode = BigInt(row.episode) + (state === 'idle' && row.last_state !== 'idle' ? 1n : 0n);
    await tx.query(
      `UPDATE corner_attention_spans SET last_state=$2,episode=$3,checked_at=now() WHERE corner_id=$1`,
      [cornerId, state, episode.toString()],
    );
    let reportDeadline = 0;
    if (state === 'idle' && BigInt(row.reported_episode) < episode) {
      const id = createHash('sha256').update(`corner-idle:${cornerId}:${episode}`).digest('hex');
      const text = `blocked: Corner ${row.name} is idle. Resume it, set a hold, or close it.`;
      const report = await reportToCommander(
        tx,
        cornerId,
        SYSTEM_IDENTITY_ID,
        text,
        undefined,
        id,
        { automatic: true, agentOnly: true, wakeInCorner: true },
      );
      if (report.retryAt) reportDeadline = report.retryAt;
      else await tx.query('UPDATE corner_attention_spans SET reported_episode=$2 WHERE corner_id=$1',
        [cornerId,episode.toString()]);
    }
    const now = Date.now();
    // Only the existing post-turn gap has an activity deadline.
    const deadlines = [
      reportDeadline ? Math.max(reportDeadline, now+1) : 0,
      row.last_turn_ended_at ? new Date(row.last_turn_ended_at).getTime() + 30_000 : 0,
    ].filter((due) => due > now);
    return { parentId: row.parent_id, deadlines };
  });
}

/** Startup recovery only; ordinary events address one corner. */
export async function runCornerAttention(db: SqlDatabase): Promise<void> {
  const rows = (
    await db.query<{ id: string }>(
      `SELECT id FROM rooms WHERE parent_id IS NOT NULL AND archived_at IS NULL`,
    )
  ).rows;
  for (const row of rows) await refreshCornerAttention(db, row.id);
}

/** The existing post-turn gap deadline; check duration never changes state. */
export class CornerAttentionDeadlines {
  private timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private release: () => void;
  private resync: () => void;
  private stopped = false;
  constructor(
    private db: SqlDatabase,
    private live: LiveHub,
    private report: (error: unknown) => void,
  ) {
    this.release = live.subscribeAll((event) => {
      if (event.type === 'invalidate' && event.reason === 'postgres:corner_state')
        void this.refresh(event.roomId).catch(report);
    });
    this.resync = live.subscribeResync(() => {
      void this.start().catch(report);
    });
  }
  async start(): Promise<void> {
    const rows = (
      await this.db.query<{ id: string }>(
        `SELECT id FROM rooms WHERE parent_id IS NOT NULL AND archived_at IS NULL`,
      )
    ).rows;
    for (const row of rows) await this.refresh(row.id);
  }
  async refresh(id: string): Promise<void> {
    if (this.stopped) return;
    const next = await refreshCornerAttention(this.db, id);
    for (const timer of this.timers.get(id) ?? []) clearTimeout(timer);
    this.timers.delete(id);
    if (!next || this.stopped) return;
    this.live.publish({ type: 'invalidate', roomId: next.parentId, reason: 'corner-status' });
    this.timers.set(
      id,
      next.deadlines.map((due) => {
        const timer = setTimeout(
          () => {
            void this.refresh(id).catch(this.report);
          },
          Math.max(1, due - Date.now()),
        );
        timer.unref?.();
        return timer;
      }),
    );
  }
  stop(): void {
    this.stopped = true;
    this.release();
    this.resync();
    for (const timers of this.timers.values()) for (const timer of timers) clearTimeout(timer);
    this.timers.clear();
  }
}
