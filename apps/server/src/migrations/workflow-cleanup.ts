import { workflowRunStatus, type WorkflowReadContract } from '@beeline/api-contract/phone';
import { workflowTimerId } from '../workflow-timer-id.js';
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
    // Serialize against handoffs, gate answers and timers from the serving release.
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('workflow-run:' || id))
      FROM (SELECT id FROM messages WHERE card_type='workflow-handoff' AND id=card->>'runId' ORDER BY id) runs`);
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
    const timers = await db.query<{ id: string; room_id: string; workflow_run: { runId: string; timer?: string; attempt?: number } }>(
      `SELECT id,room_id,workflow_run FROM agent_schedules WHERE workflow_run IS NOT NULL
        AND (NOT workflow_run ? 'timer' OR (workflow_run->>'timer'='step' AND NOT workflow_run ? 'attempt'))`,
    );
    for (const timer of timers.rows) {
      const current = (await db.query<{ seq: number }>(
        `SELECT (card->>'seq')::int seq FROM messages WHERE room_id=$1 AND card_type='workflow-handoff'
          AND card->>'runId'=$2 ORDER BY (card->>'seq')::int DESC,created_at DESC,id DESC LIMIT 1`,
        [timer.room_id, timer.workflow_run.runId],
      )).rows[0];
      if (!current) continue;
      const id = workflowTimerId(timer.workflow_run.runId, 'step');
      // If a newer timer already exists it owns the lease; remove only the old duplicate.
      if (timer.id !== id && (await db.query(`SELECT 1 FROM agent_schedules WHERE id=$1`, [id])).rowCount) {
        await db.query(`DELETE FROM agent_schedules WHERE id=$1`, [timer.id]);
        continue;
      }
      await db.query(`UPDATE agent_schedules SET id=$2,workflow_run=workflow_run ||
        jsonb_build_object('timer','step','attempt',$3::int) WHERE id=$1`, [timer.id, id, current.seq]);
    }
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
  const starts = await database.query<{ id: string; room_id: string }>(
    `SELECT id,room_id FROM messages
     WHERE card_type='workflow-handoff' AND ${workflowRunStatusUnsavedSql('card', 'id')}`,
  );
  for (const start of starts.rows) {
    await database.transaction(async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('workflow-run:' || $1::text))`, [start.id]);
      const head = (await db.query<{ card: { toState: string; status?: 'done' | 'failed' | 'abandoned'; cancellation?: unknown }; markdown: string | null }>(
        `SELECT head.card,version.markdown FROM messages head
         JOIN rooms room ON room.id=head.room_id
         LEFT JOIN workspace_skills skill ON skill.workspace_id=room.workspace_id AND skill.kind='workflow'
           AND skill.slug=head.card->>'workflowSlug'
         LEFT JOIN workspace_skill_versions version ON version.skill_id=skill.id
           AND version.version=COALESCE((head.card->>'workflowVersion')::int,1)
         WHERE head.room_id=$2 AND head.card_type='workflow-handoff' AND head.card->>'runId'=$1
           AND head.card->>'toState' IS NOT NULL
         ORDER BY (head.card->>'seq')::int DESC NULLS LAST,head.created_at DESC,head.id DESC LIMIT 1`,
        [start.id, start.room_id],
      )).rows[0];
      if (!head) return;
      let contract: WorkflowReadContract = { handoffs: {} } as WorkflowReadContract;
      try {
        const parsed = head.markdown ? JSON.parse(head.markdown) : undefined;
        if (parsed?.handoffs && typeof parsed.handoffs === 'object') contract = parsed as WorkflowReadContract;
        else console.warn(`saveUnsavedWorkflowRunStatus: run ${start.id} has no readable pinned contract`);
      } catch {
        console.warn(`saveUnsavedWorkflowRunStatus: run ${start.id} has an unreadable pinned contract`);
      }
      const status = workflowRunStatus(contract, head.card.toState, head.card.cancellation ? 'abandoned' : head.card.status);
      await db.query(
        `UPDATE messages SET card=(card - 'active') || jsonb_build_object('runStatus',$2::text) WHERE id=$1`,
        [start.id, status],
      );
    });
  }
  if (starts.rows.length) console.log(`saveUnsavedWorkflowRunStatus: saved ${starts.rows.length} run status(es)`);
  return starts.rows.length;
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
