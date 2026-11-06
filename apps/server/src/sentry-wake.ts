import { SENTRY_TRIAGE_ROOM } from './sentry-wake-source.js';
import { notifySentryWake } from './postgres-live.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { quoteOutsideData } from '@beeline/api-contract/phone';
import { redactDiagnostic } from '@beeline/api-contract/error-reporting';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { createAgentCommand } from './agent-command.js';
import { ensureSystemIdentity } from './system-line.js';

export function sentryWakeAgentFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const agentId = env.BEELINE_SENTRY_TRIAGE_AGENT_ID ?? '7eafb2e0cc049a9b3345f4322024b604358af04cb551d1fc71084ca3a99d7877';
  if (!/^[0-9a-f]{64}$/.test(agentId)) throw new Error('BEELINE_SENTRY_TRIAGE_AGENT_ID must be an agent public key');
  return agentId;
}
const TRIAGE = SENTRY_TRIAGE_ROOM;
export const SENTRY_WAKE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sentry_wake_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton)
);
INSERT INTO sentry_wake_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS sentry_wake_issues (
 issue_id text NOT NULL,
 event_type text NOT NULL,
 title text NOT NULL,
 level text NOT NULL,
 culprit text NOT NULL,
 permalink text NOT NULL,
 first_seen timestamptz NOT NULL,
 last_seen timestamptz NOT NULL,
 event_count bigint NOT NULL,
 delivery_hash text NOT NULL,
 pending boolean NOT NULL DEFAULT true,
 PRIMARY KEY(issue_id,event_type)
);
CREATE INDEX IF NOT EXISTS sentry_wake_pending ON sentry_wake_issues(last_seen) WHERE pending;
`;

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit = 500): string => typeof value === 'string' ? value.slice(0, limit) : '';
function timestamp(value: unknown, fallback: Date): string {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback.toISOString();
}

/** Authenticate the original bytes before parsing any provider data. */
export async function receiveSentryWake(db: SqlDatabase, raw: Buffer,
  headers: Record<string, string | string[] | undefined>, secret: string | undefined,
  agentId = sentryWakeAgentFromEnv()): Promise<number> {
  const signature = headers['sentry-hook-signature'];
  if (!secret || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature) ||
      !timingSafeEqual(createHmac('sha256', secret).update(raw).digest(), Buffer.from(signature, 'hex'))) return 401;
  let payload: Record<string, unknown>;
  try { payload = object(JSON.parse(raw.toString('utf8'))); } catch { return 400; }
  const data = object(payload.data);
  const resource = headers['sentry-hook-resource'];
  const action = payload.action;
  const eventType = resource === 'issue' && action === 'created' ? 'issue.created'
    : resource === 'issue' && action === 'unresolved' ? 'issue.unresolved'
    : resource === 'issue' && action === 'regressed' ? 'issue.regression'
    : resource === 'event_alert' && action === 'triggered' ? 'event.alert' : null;
  if (!eventType) return 202;
  const issue = object(data.issue);
  const event = object(data.event);
  const candidateId = issue.id ?? event.issue_id ?? event.groupID ?? event.group_id;
  const issueId = typeof candidateId === 'number' ? String(candidateId) : text(candidateId, 100);
  const title = redactDiagnostic(text(issue.title ?? event.title));
  if (!/^\d+$/.test(issueId) || !title) return 400;
  const count = Number(issue.count ?? event.count ?? 1);
  if (!Number.isSafeInteger(count) || count < 0) return 400;
  const now = new Date();
  await db.transaction(async tx => {
    // The singleton lock also orders ingestion against a batch being committed.
    await tx.query(`SELECT singleton FROM sentry_wake_state WHERE singleton FOR UPDATE`);
    const level = text(issue.level ?? event.level, 20) || 'error';
    await tx.query(`INSERT INTO sentry_wake_issues
      (issue_id,event_type,title,level,culprit,permalink,first_seen,last_seen,event_count,delivery_hash,pending)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
      ON CONFLICT(issue_id,event_type) DO UPDATE SET
        title=EXCLUDED.title,level=EXCLUDED.level,culprit=EXCLUDED.culprit,
        first_seen=LEAST(sentry_wake_issues.first_seen,EXCLUDED.first_seen),
        last_seen=EXCLUDED.last_seen,event_count=GREATEST(sentry_wake_issues.event_count,EXCLUDED.event_count),
        delivery_hash=EXCLUDED.delivery_hash,pending=sentry_wake_issues.pending OR EXCLUDED.pending
      WHERE sentry_wake_issues.delivery_hash<>EXCLUDED.delivery_hash
        AND sentry_wake_issues.last_seen<=EXCLUDED.last_seen`,
    [issueId,eventType,title,level,redactDiagnostic(text(issue.culprit ?? event.culprit)),
      `https://beeline-bt.sentry.io/issues/${issueId}/`, timestamp(issue.firstSeen ?? event.datetime, now),
      timestamp(issue.lastSeen ?? event.datetime, now),count,createHash('sha256').update(raw).digest('hex')]);
    await notifySentryWake(tx);
  });
  await flushSentryWakes(db, agentId);
  return 200;
}

/** The command and batch acknowledgement commit together under a cross-machine row lock.
 * False parks an empty, unauthorized or busy batch; it creates no retry deadline. */
export async function flushSentryWakes(db: SqlDatabase, agentId = sentryWakeAgentFromEnv()): Promise<boolean> {
  try { return await db.transaction(async tx => {
    await tx.query(`SELECT singleton FROM sentry_wake_state WHERE singleton FOR UPDATE`);
    const issues = await tx.query<{ issue_id: string; level: string; title: string; permalink: string; event_count: string }>(
      `SELECT issue_id,level,title,permalink,event_count FROM sentry_wake_issues
       WHERE pending ORDER BY last_seen,issue_id,event_type`);
    if (!issues.rowCount) return false;
    await ensureSystemIdentity(tx);
    const digest = `${issues.rowCount} Sentry issue events\n` + issues.rows.map(row =>
      `${row.level}: ${row.title} ${row.permalink} (${row.event_count} events)`).join('\n');
    const command = await createAgentCommand(tx, {
      roomId: TRIAGE, agentId, sourceMessageId: null, reason: 'subscribed_event',
      privatePayload: { kind: 'lifecycle', authorId: SYSTEM_IDENTITY_ID, fromRoomId: TRIAGE,
        text: `${quoteOutsideData('Sentry digest', digest)}\n\nInvestigate these Sentry issues. Post one short visible summary line in this triage corner for every digest, naming each Sentry short ID (look it up from the linked issue if needed) and its action: dismissed, existing corner, or new corner. When a code fix is warranted, open and own a fix corner with yourself as implementer and Speedy as reviewer, linking the Sentry issue id and URL in its brief. Follow existing corner authority and merge rules. When a fix corner you opened from a digest reports blocked: or needs-decision:, handle the report here as its commander: try other vault keys, tools, or a narrower scope; decide, re-order the fix corner, or close it with evidence. Do not forward the report to your own Room session. Only when a human must act (sign-in, payment, approval, or a product decision), post the exact blocker in the issues-triage corner (a914716f-cd6c-4663-b42a-6e1044dc2bb9) and tag the Workspace owner @lunchboxfortwo.` },
    });
    if (!command) return false;
    await tx.query(`UPDATE sentry_wake_issues SET pending=false WHERE pending`);
    return true;
  }); } catch (error) {
    if ((error as { code?: string } | null)?.code !== '55P03') throw error;
    // FK/trigger locks can still be busy after the dispatch reservation.
    // Rollback retains the batch; no failed-observation retry is due.
    console.warn('[sentry-wake] dispatch deferred while database rows are busy');
    return false;
  }
}
