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

export async function cleanup(client, apply = false) {
  await client.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query("SET LOCAL lock_timeout='500ms'");
    const counts = [];
    for (const [table, predicate] of [...deletions, ...updates.map(([table, , predicate]) => [table, predicate])]) {
      const exists = (await client.query('SELECT to_regclass($1) AS name', [table])).rows[0].name;
      if (!exists) { counts.push({ table, count: 0, absent: true }); continue; }
      const count = Number((await client.query(`SELECT count(*) AS count FROM ${table} WHERE ${predicate}`)).rows[0].count);
      counts.push({ table, predicate, count });
    }
    const telemetryBefore = {};
    for (const table of retainedTelemetry) {
      const exists = (await client.query('SELECT to_regclass($1) AS name', [table])).rows[0].name;
      telemetryBefore[table] = exists ? Number((await client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count) : 0;
    }
    const versions = Number((await client.query('SELECT count(*) AS count FROM workspace_skill_versions')).rows[0].count);
    const linkedVersions = Number((await client.query(`SELECT count(*) AS count FROM workspace_skill_versions
      WHERE source_job_id IN (SELECT id FROM institutional_memory_jobs)`)).rows[0].count);
    if (apply) {
      // Detach the destructive cascade BEFORE deleting any extraction rows.
      await client.query(`ALTER TABLE workspace_skill_versions DROP CONSTRAINT IF EXISTS workspace_skill_versions_source_job_id_fkey`);
      await client.query(`ALTER TABLE workspace_skill_versions ALTER COLUMN source_job_id DROP NOT NULL`);
      await client.query(`ALTER TABLE workspace_skill_versions ADD CONSTRAINT workspace_skill_versions_source_job_id_fkey
        FOREIGN KEY(source_job_id) REFERENCES institutional_memory_jobs(id) ON DELETE SET NULL`);
      for (const [table, predicate] of deletions) {
        if (!counts.find(row => row.table === table)?.absent) await client.query(`DELETE FROM ${table} WHERE ${predicate}`);
      }
      for (const [table, assignment, predicate] of updates) {
        if (counts.find(row => row.table === table)?.absent) continue;
        if (table === 'messages') {
          // Bound each statement while keeping the one-time apply atomic.
          for (;;) {
            const batch = await client.query(`UPDATE messages SET ${assignment} WHERE id IN (
              SELECT id FROM messages WHERE ${predicate} LIMIT 1000)`);
            if (Number(batch.rowCount ?? batch.affectedRows ?? batch.rows.length) < 1000) break;
          }
        } else await client.query(`UPDATE ${table} SET ${assignment} WHERE ${predicate}`);
      }
      const after = Number((await client.query('SELECT count(*) AS count FROM workspace_skill_versions')).rows[0].count);
      if (after !== versions) throw new Error(`Skill-version preservation failed: ${versions} -> ${after}`);
    }
    const telemetryAfter = {};
    for (const table of retainedTelemetry) {
      const exists = (await client.query('SELECT to_regclass($1) AS name', [table])).rows[0].name;
      telemetryAfter[table] = exists ? Number((await client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count) : 0;
      if (apply && telemetryAfter[table] !== telemetryBefore[table]) throw new Error(`${table} changed during cleanup`);
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { mode: apply ? 'applied' : 'dry-run', counts, skillVersions: versions, linkedVersionsPreserved: linkedVersions,
      retainedTelemetry: { before: telemetryBefore, after: telemetryAfter } };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/audit-decisions-cleanup.mjs [--apply]');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try { await client.connect(); console.log(JSON.stringify(await cleanup(client, process.argv.includes('--apply')), null, 2)); }
  finally { await client.end(); }
}
