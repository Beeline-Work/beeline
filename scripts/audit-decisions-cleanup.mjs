/** B1: reviewed one-time cleanup. Default is READ ONLY; never part of deploy/maintenance.
 * Use DATABASE_URL from the existing environment. Prints aggregates only.
 * Firstmate must obtain the captain's explicit B1 yes before --apply.
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';

// Each predicate is the bloat audit D1's approved dead class.
// Captain/firstmate inbox 002 explicitly EXCLUDES rooms_mcp_audit and agent_turn_traces;
// neither table is selected for deletion, and their writers stay on (B7).
export const deletions = [
  ['institutional_memory_outcomes', 'TRUE'],
  ['institutional_history_searches', 'TRUE'],
  ['workspace_skill_uses', 'TRUE'],
  ['institutional_memory_fact_events', 'TRUE'],
  ['institutional_review_findings', 'TRUE'],
  ['institutional_memory_jobs', 'TRUE'],
  ['beeline_github_webhook_deliveries', "received_at<now()-interval '30 days'"],
  ['beeline_github_repo_events', "received_at<now()-interval '30 days'"],
  ['operator_finance_snapshots', "source='entered' AND scope='fixed-plan'"],
  ['corner_attention_flags', 'TRUE'],
  ['service_review_rollout', 'TRUE'],
  ['google_oauth_grants', 'TRUE'],
  ['push_level_migration_counts', 'TRUE'],
  ['wallet_balance_snapshots', 'TRUE'],
];
export const updates = [
  ['messages', "card=card-'source'-'dedupe'", "card_type='github-corner-note' AND (card ? 'source' OR card ? 'dedupe')"],
  ['identities', 'welcome_cards_due=NULL', 'welcome_cards_due IS NOT NULL'],
  ['room_read_marks', 'read_at=NULL', 'read_at IS NOT NULL'],
  ['needs_you_marks', 'reminder_dismissed_at=NULL', 'reminder_dismissed_at IS NOT NULL'],
  ['github_star_prompts', 'reached_at=NULL,last_win_at=NULL', 'reached_at IS NOT NULL OR last_win_at IS NOT NULL'],
];

export const retainedTelemetry = ['rooms_mcp_audit', 'agent_turn_traces'];

async function retainedCounts(client, cutoff) {
  const counts = {};
  for (const table of retainedTelemetry) {
    const exists = (await client.query('SELECT to_regclass($1) AS name', [table])).rows[0].name;
    counts[table] = exists ? Number((await client.query(
      `SELECT count(*) AS count FROM ${table} WHERE created_at<=$1::timestamptz`, [cutoff])).rows[0].count) : 0;
  }
  return counts;
}

async function readPlan(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='60s'");
    const cutoff = (await client.query('SELECT transaction_timestamp()::text AS cutoff')).rows[0].cutoff;
    const counts = [];
    for (const [table, predicate] of [...deletions, ...updates.map(([table, , predicate]) => [table, predicate])]) {
      const exists = (await client.query('SELECT to_regclass($1) AS name', [table])).rows[0].name;
      if (!exists) { counts.push({ table, count: 0, absent: true }); continue; }
      const count = Number((await client.query(`SELECT count(*) AS count FROM ${table} WHERE ${predicate}`)).rows[0].count);
      counts.push({ table, predicate, count });
    }
    const versions = Number((await client.query('SELECT count(*) AS count FROM workspace_skill_versions')).rows[0].count);
    const linkedVersions = Number((await client.query(`SELECT count(*) AS count FROM workspace_skill_versions
      WHERE source_job_id IN (SELECT id FROM institutional_memory_jobs)`)).rows[0].count);
    const telemetry = await retainedCounts(client, cutoff);
    await client.query('ROLLBACK');
    return { mode: 'dry-run', cutoff, counts, skillVersions: versions, linkedVersionsPreserved: linkedVersions,
      retainedTelemetry: { cutoff, before: telemetry, after: telemetry } };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function cleanup(client, apply = false, beforeWrite = async () => {}) {
  const plan = await readPlan(client);
  if (!apply) return plan;
  // Commit the short FK switch BEFORE bulk data work. Otherwise its DDL and
  // live-journal row locks would remain held across the whole card cleanup.
  await beforeWrite('before-fk');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query(`ALTER TABLE workspace_skill_versions DROP CONSTRAINT IF EXISTS workspace_skill_versions_source_job_id_fkey`);
    await client.query(`ALTER TABLE workspace_skill_versions ALTER COLUMN source_job_id DROP NOT NULL`);
    await client.query(`ALTER TABLE workspace_skill_versions ADD CONSTRAINT workspace_skill_versions_source_job_id_fkey
      FOREIGN KEY(source_job_id) REFERENCES institutional_memory_jobs(id) ON DELETE SET NULL`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  await beforeWrite('after-fk');
  await client.query("SET statement_timeout='60s'");
  await client.query("SET lock_timeout='2s'");
  const changed = {};
  for (const [table, predicate] of deletions) {
    if (plan.counts.find(row => row.table === table)?.absent) continue;
    changed[table] = 0;
    for (;;) {
      await beforeWrite('ledger-batch');
      // Each query autocommits; no ledger or live-stream lock spans batches.
      const batch = await client.query(`DELETE FROM ${table} WHERE ctid IN (
        SELECT ctid FROM ${table} WHERE ${predicate} LIMIT 1000)`);
      const count = Number(batch.rowCount ?? batch.affectedRows ?? batch.rows.length);
      changed[table] += count;
      if (count < 1000) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  for (const [table, assignment, predicate] of updates) {
    if (plan.counts.find(row => row.table === table)?.absent) continue;
    if (table !== 'messages') {
      await beforeWrite('value-cleanup');
      const result = await client.query(`UPDATE ${table} SET ${assignment} WHERE ${predicate}`);
      changed[table] = Number(result.rowCount ?? result.affectedRows ?? result.rows.length);
      continue;
    }
    let cursor = null;
    changed.messages = 0;
    for (;;) {
      await beforeWrite('card-batch');
      // A fixed cohort and keyset avoid chasing new notes or rescanning stripped
      // keys. Small autocommitted batches release live-stream locks promptly.
      const batch = await client.query(`UPDATE messages SET ${assignment} WHERE id IN (
        SELECT id FROM messages WHERE ${predicate} AND created_at<=$1::timestamptz
          AND ($2::text IS NULL OR id>$2::text) ORDER BY id LIMIT 25) RETURNING id`, [plan.cutoff, cursor]);
      changed.messages += batch.rows.length;
      if (batch.rows.length < 25) break;
      cursor = batch.rows.map(row => row.id).sort().at(-1);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const afterVersions = Number((await client.query('SELECT count(*) AS count FROM workspace_skill_versions')).rows[0].count);
  if (afterVersions < plan.skillVersions) throw new Error(`Skill-version preservation failed: ${plan.skillVersions} -> ${afterVersions}`);
  const telemetryAfter = await retainedCounts(client, plan.cutoff);
  for (const table of retainedTelemetry)
    if (telemetryAfter[table] !== plan.retainedTelemetry.before[table]) throw new Error(`${table} cohort changed during cleanup`);
  return { ...plan, mode: 'applied', changed, afterSkillVersions: afterVersions,
    retainedTelemetry: { cutoff: plan.cutoff, before: plan.retainedTelemetry.before, after: telemetryAfter } };
}

/** Separate observer connection: cancel this cleanup on the first observed wait. */
export async function monitoredApply(client, observer) {
  const pid = client.processID;
  if (!Number.isInteger(pid)) throw new Error('Cleanup monitoring requires its PostgreSQL backend PID');
  let stopped = false, failure, checking, samples = 0, lastSample, afterFk;
  const inspect = async () => {
    if (failure) throw failure;
    lastSample = (await observer.query(`SELECT
      (SELECT count(*) FROM pg_stat_activity activity WHERE $1=ANY(pg_blocking_pids(activity.pid))) AS blocked_clients,
      (SELECT count(*) FROM pg_locks WHERE pid=$1 AND NOT granted) AS waiting_locks`, [pid])).rows[0];
    samples++;
    if (Number(lastSample.blocked_clients) || Number(lastSample.waiting_locks))
      throw new Error(`Cleanup stopped for blocking: clients=${lastSample.blocked_clients}, waiting locks=${lastSample.waiting_locks}`);
  };
  const check = () => checking ??= inspect().finally(() => { checking = undefined; });
  await check();
  const watcher = (async () => {
    while (!stopped) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (stopped) break;
      try { await check(); }
      catch (error) {
        failure = error;
        await observer.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => {});
        break;
      }
    }
  })();
  try {
    const result = await cleanup(client, true, async phase => {
      if (failure) throw failure;
      await check();
      if (phase === 'after-fk') afterFk = lastSample;
    });
    if (failure) throw failure;
    return { ...result, monitoring: { samples, afterFk, stoppedForBlocking: false } };
  } finally { stopped = true; await watcher; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/audit-decisions-cleanup.mjs [--apply]');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const apply = process.argv.includes('--apply');
  try {
    await client.connect();
    if (apply) await observer.connect();
    console.log(JSON.stringify(apply ? await monitoredApply(client, observer) : await cleanup(client), null, 2));
  } finally { if (apply) await observer.end(); await client.end(); }
}
