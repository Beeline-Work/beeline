import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { workflowRunStatus, type WorkflowReadContract } from '@beeline/api-contract/phone';
import { workflowRunStatusUnsavedSql } from '../workflow-run-saved-status.js';
import type { SqlDatabase } from '../database.js';

/** Run idempotent backfills once, preserving their own transaction boundaries. */
export async function workflowBackfillOnce(
  database: SqlDatabase,
  name: string,
  backfill: (db: SqlDatabase) => Promise<unknown>,
): Promise<void> {
  const completed = await database.query(`SELECT name FROM workflow_backfills WHERE name=$1`, [name]);
  if (completed.rows.length) return;
  // Recovery isolates errors per run. An outer transaction would poison all
  // later queries after a caught SQL error. Interrupted/concurrent boots may retry.
  await backfill(database);
  await database.query(`INSERT INTO workflow_backfills(name) VALUES($1) ON CONFLICT DO NOTHING`, [name]);
}

/** Fill legacy storage without dispatching, closing, or restarting any run. */
export async function normalizeLegacyWorkflowRuns(database: SqlDatabase): Promise<void> {
  await database.transaction(async (db) => {
    // Number the old prefix ending at zero, or just before the first existing
    // attempt. Existing numbered attempts and their in-flight wakes stay valid.
    await db.query(`WITH missing AS (
      SELECT id,COALESCE(min((card->>'seq')::int) OVER (PARTITION BY room_id,card->>'runId'),1) first_seq,
        count(*) FILTER (WHERE NOT card ? 'seq') OVER (PARTITION BY room_id,card->>'runId' ORDER BY created_at,id ROWS UNBOUNDED PRECEDING) ordinal,
        count(*) FILTER (WHERE NOT card ? 'seq') OVER (PARTITION BY room_id,card->>'runId') missing_count
      FROM messages WHERE card_type='workflow-handoff' AND card->>'toState' IS NOT NULL
    ) UPDATE messages message SET card=message.card || jsonb_build_object('seq',missing.first_seq-missing.missing_count+missing.ordinal-1)
      FROM missing WHERE message.id=missing.id AND NOT message.card ? 'seq'`);
    await db.query(`UPDATE messages gate SET card=gate.card || jsonb_build_object('attempt',(
        SELECT (head.card->>'seq')::int FROM messages head
        WHERE head.room_id=gate.room_id AND head.card_type='workflow-handoff'
          AND head.card->>'runId'=gate.card->>'runId' AND head.created_at<=gate.created_at
          AND left((head.card->>'workflowSlug') || ': ' || (head.card->>'toState'),120)=choice.prompt
        ORDER BY (head.card->>'seq')::int DESC,head.created_at DESC,head.id DESC LIMIT 1))
      FROM room_choices choice WHERE choice.message_id=gate.id AND gate.card->>'runId' IS NOT NULL
        AND NOT gate.card ? 'attempt'`);

  });
}

/**
 * Save `runStatus` on every start card that lacks it or still carries the
 * retired `active` flag, from the run's newest card and pinned contract, and
 * drop `active`. Runs every release: a release still serving during the
 * migration may start or end runs the old way. The partial index on the same
 * predicate keeps a converged pass to an empty index read.
 */
export async function saveUnsavedWorkflowRunStatus(database: SqlDatabase): Promise<number> {
  const starts = (await database.query<{
    id:string;version:number;card:{toState:string;status?:'done'|'failed'|'abandoned';cancellation?:unknown};markdown:string|null;
  }>(`SELECT start.id,start.version,head.card,version.markdown FROM messages start
    JOIN rooms room ON room.id=start.room_id JOIN LATERAL (
      SELECT candidate.card FROM messages candidate WHERE candidate.room_id=start.room_id
        AND candidate.card_type='workflow-handoff' AND candidate.card->>'runId'=start.id
        AND candidate.card->>'toState' IS NOT NULL
      ORDER BY (candidate.card->>'seq')::int DESC NULLS LAST,candidate.created_at DESC,candidate.id DESC LIMIT 1
    ) head ON true
    LEFT JOIN workspace_skills skill ON skill.workspace_id=room.workspace_id AND skill.kind='workflow'
      AND skill.slug=head.card->>'workflowSlug'
    LEFT JOIN workspace_skill_versions version ON version.skill_id=skill.id
      AND version.version=COALESCE((head.card->>'workflowVersion')::int,1)
    WHERE start.card_type='workflow-handoff' AND ${workflowRunStatusUnsavedSql('start.card','start.id')}`)).rows;
  const changes=starts.map(start=>{
    let contract:WorkflowReadContract={handoffs:{}} as WorkflowReadContract;
    try {
      const parsed=start.markdown?JSON.parse(start.markdown):undefined;
      if(parsed?.handoffs && typeof parsed.handoffs==='object') contract=parsed as WorkflowReadContract;
      else console.warn(`saveUnsavedWorkflowRunStatus: run ${start.id} has no readable pinned contract`);
    } catch { console.warn(`saveUnsavedWorkflowRunStatus: run ${start.id} has an unreadable pinned contract`); }
    return {id:start.id,version:start.version,status:workflowRunStatus(contract,start.card.toState,
      start.card.cancellation?systemMessage("workflow-cleanup.abandoned"):start.card.status)};
  });
  const saved=await database.query(`UPDATE messages start SET card=(start.card-'active') || jsonb_build_object('runStatus',change.status)
    FROM jsonb_to_recordset($1::jsonb) change(id text,version int,status text)
    WHERE start.id=change.id AND start.version=change.version AND ${workflowRunStatusUnsavedSql('start.card','start.id')}`,
    [JSON.stringify(changes)]);
  if(saved.rowCount) console.log(`saveUnsavedWorkflowRunStatus: saved ${saved.rowCount} run status(es)`);
  return saved.rowCount;
}

/** Name saved workflows whose current version still ends as abandoned; their next save must pick done or failed. */
export async function reportAbandonedWorkflowEndings(database: SqlDatabase): Promise<string[]> {
  const rows = (await database.query<{ workspace_id: string; slug: string; markdown: string }>(
    `SELECT skill.workspace_id,skill.slug,version.markdown FROM workspace_skills skill
     JOIN workspace_skill_versions version ON version.skill_id=skill.id AND version.version=skill.current_version
     WHERE skill.kind='workflow' AND skill.state<>'archived'`,
  )).rows;
  const found: string[] = [];
  for (const row of rows) {
    let handoffs: Record<string, { kind?: string; status?: string }> = {};
    try { handoffs = JSON.parse(row.markdown)?.handoffs ?? {}; } catch { continue; }
    if (Object.values(handoffs).some((state) => state?.kind === 'terminal' && state.status === 'abandoned'))
      found.push(`${row.workspace_id}/${row.slug}`);
  }
  if (found.length)
    console.warn(`reportAbandonedWorkflowEndings: ${found.length} saved workflow(s) declare an abandoned ending and must change it on their next save: ${found.join(', ')}`);
  return found;
}
