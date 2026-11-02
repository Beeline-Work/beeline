import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { createHash } from 'node:crypto';
import { sanitizeTurnReplay } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import { sendSystemDirectMessage } from './system-line.js';

export const STARTUP_WAKE_BACKOFF_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_startup_backoff (
  agent_id text PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
  failures integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  paused_until timestamptz
);
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS startup_outcome text;
CREATE INDEX IF NOT EXISTS agent_commands_startup_wakes ON agent_commands(startup_wake_after)
  WHERE state='pending' AND startup_wake_after IS NOT NULL;
CREATE OR REPLACE FUNCTION defer_startup_wake() RETURNS trigger LANGUAGE plpgsql AS $backoff$
BEGIN
  IF NEW.state='pending' AND NOT ${startupWakeAllowedSql('NEW')} THEN
    SELECT paused_until INTO NEW.startup_wake_after FROM agent_startup_backoff WHERE agent_id=NEW.agent_id;
  END IF;
  RETURN NEW;
END $backoff$;
DROP TRIGGER IF EXISTS defer_startup_wake ON agent_commands;
CREATE TRIGGER defer_startup_wake BEFORE INSERT OR UPDATE OF state ON agent_commands
  FOR EACH ROW EXECUTE FUNCTION defer_startup_wake();
CREATE TABLE IF NOT EXISTS automatic_report_wakes (
  corner_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  next_at timestamptz NOT NULL,
  PRIMARY KEY(corner_id,agent_id)
);
`;

/** Only the immediate human request bypasses a pause; inherited human roots do not. */
export function startupWakeAllowedSql(command: string): string {
  return `(${command}.action NOT IN ('input','resume') OR NOT EXISTS (
    SELECT 1 FROM agent_startup_backoff pause WHERE pause.agent_id=${command}.agent_id AND pause.paused_until>now()
  ) OR EXISTS (SELECT 1 FROM messages source JOIN identities author ON author.id=source.author_id
    WHERE source.id=${command}.source_message_id AND author.kind='human' AND author.id<>'${SYSTEM_IDENTITY_ID}'
      AND source.presentation='message' AND source.system_event IS NULL
      AND ${command}.reason<>'schedule' AND ${command}.private_payload IS NULL
  ) OR (${command}.private_payload->>'kind'='order' AND EXISTS (
    SELECT 1 FROM identities author WHERE author.id=${command}.private_payload->>'authorId' AND author.kind='human' AND author.id<>'${SYSTEM_IDENTITY_ID}'
  )))`;
}

/** The terminal receipt owns the breaker, across every Room and server instance. */
export async function recordStartupWakeOutcome(db: SqlDatabase, input: {
  roomId: string; requestId: string; generationId?: string; status: string;
  toolCalls?: number; trace?: unknown; reasonKind?: string;
}, agentId: string): Promise<void> {
  if (!['failed','complete'].includes(input.status) || input.reasonKind === 'update-interrupted') return;
  await db.query(`INSERT INTO agent_startup_backoff(agent_id) VALUES($1) ON CONFLICT DO NOTHING`, [agentId]);
  await db.query(`SELECT agent_id FROM agent_startup_backoff WHERE agent_id=$1 FOR UPDATE`, [agentId]);
  const fresh = await db.query(`UPDATE agent_turns SET startup_outcome=$4
    WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 AND startup_outcome IS DISTINCT FROM $4
    RETURNING room_id`, [input.roomId,agentId,input.requestId,`${input.generationId ?? ''}:${input.status}`]);
  if (!fresh.rowCount) return;
  const trace = sanitizeTurnReplay(input.trace);
  // Activation/context failed before a prompt. Older helpers still identify
  // workspace bootstrap failures explicitly, without replay diagnostics.
  const startup = input.status === 'failed' && (input.toolCalls ?? 0) === 0 &&
    (trace?.attempts.length ? trace.attempts.every(attempt => attempt.tools.length === 0 &&
      !('first-model-output' in attempt.phases) && !('model-stream' in attempt.phases))
      : input.reasonKind === 'workspace-failure');
  if (!startup) {
    await db.query(`UPDATE agent_startup_backoff SET failures=0,window_started_at=now(),
      paused_until=CASE WHEN $2='complete' THEN NULL ELSE paused_until END WHERE agent_id=$1`, [agentId,input.status]);
    if (input.status === 'complete') await db.query(`UPDATE agent_commands SET startup_wake_after=NULL
      WHERE agent_id=$1 AND state='pending' AND startup_wake_after IS NOT NULL`, [agentId]);
    return;
  }
  const paused = await db.query<{ paused_until: Date }>(`UPDATE agent_startup_backoff SET
    failures=CASE WHEN window_started_at<now()-interval '2 minutes' THEN 1 ELSE failures+1 END,
    window_started_at=CASE WHEN window_started_at<now()-interval '2 minutes' THEN now() ELSE window_started_at END
    WHERE agent_id=$1 AND (paused_until IS NULL OR paused_until<=now()) RETURNING paused_until`, [agentId]);
  if (!paused.rowCount) return;
  const opened = await db.query<{ paused_until: Date }>(`UPDATE agent_startup_backoff
    SET paused_until=now()+interval '5 minutes' WHERE agent_id=$1 AND failures>=5
    RETURNING paused_until`, [agentId]);
  if (!opened.rowCount) return;
  await db.query(`UPDATE agent_commands command SET startup_wake_after=$2
    WHERE agent_id=$1 AND state='pending' AND NOT ${startupWakeAllowedSql('command')}`,
    [agentId,opened.rows[0]!.paused_until]);
  const owner = (await db.query<{ owner_id: string; name: string; workspace_id: string }>(
    `SELECT agent.owner_id,identity.name,room.workspace_id FROM agents agent
      JOIN identities identity ON identity.id=agent.agent_id JOIN rooms room ON room.id=$2
      WHERE agent.agent_id=$1 AND EXISTS(SELECT 1 FROM memberships member
        WHERE member.workspace_id=room.workspace_id AND member.room_id IS NULL
          AND member.identity_id=agent.owner_id AND member.removed_at IS NULL)`, [agentId,input.roomId])).rows[0];
  if (owner) await sendSystemDirectMessage(db,owner.workspace_id,owner.owner_id,
    systemMessage("startup-wake-backoff.keeps-failing-to-start-automatic-wakes-are-paused-for-5-minutes", owner.name),
    createHash('sha256').update(`startup-backoff:${agentId}:${opened.rows[0]!.paused_until.toISOString()}`).digest('hex'));
}


/** Existing durable wake tick also releases paused commands after restart. */
export async function flushStartupWakeBackoffs(db: SqlDatabase): Promise<void> {
  await db.query(`UPDATE agent_commands SET startup_wake_after=NULL
    WHERE state='pending' AND startup_wake_after<=now()`);
}
