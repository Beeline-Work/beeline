import { workflowRunStatus, type WorkflowReadContract } from '@beeline/api-contract/phone';
import { workflowTimerId } from '../workflow-timer-id.js';
import type { SqlDatabase } from '../database.js';

/** Commit a backfill and its marker together; a failed release can retry it. */
export async function workflowBackfillOnce(
  database: SqlDatabase,
  name: string,
  backfill: (db: SqlDatabase) => Promise<unknown>,
): Promise<void> {
  await database.transaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`workflow-backfill:${name}`]);
    const completed = await db.query(`SELECT name FROM workflow_backfills WHERE name=$1`, [name]);
    if (completed.rows.length) return;
    await backfill(db);
    await db.query(`INSERT INTO workflow_backfills(name) VALUES($1)`, [name]);
  });
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
    const starts = await db.query<{ id: string; card: { toState: string; status?: 'done' | 'failed' | 'abandoned'; cancellation?: unknown }; markdown: string | null }>(
      `SELECT start.id,head.card,version.markdown FROM messages start
       JOIN rooms room ON room.id=start.room_id
       JOIN LATERAL (SELECT card FROM messages WHERE room_id=start.room_id AND card_type='workflow-handoff'
         AND card->>'runId'=start.id AND card->>'toState' IS NOT NULL
         ORDER BY (card->>'seq')::int DESC,created_at DESC,id DESC LIMIT 1) head ON true
       LEFT JOIN workspace_skills skill ON skill.workspace_id=room.workspace_id AND skill.kind='workflow'
         AND skill.slug=head.card->>'workflowSlug'
       LEFT JOIN workspace_skill_versions version ON version.skill_id=skill.id AND version.version=(head.card->>'workflowVersion')::int
       WHERE start.card_type='workflow-handoff' AND start.id=start.card->>'runId' AND NOT start.card ? 'active'`,
    );
    for (const start of starts.rows) {
      let contract: WorkflowReadContract = { handoffs: {} } as WorkflowReadContract;
      try {
        const parsed = start.markdown ? JSON.parse(start.markdown) : undefined;
        if (parsed?.handoffs && typeof parsed.handoffs === 'object') contract = parsed as WorkflowReadContract;
      } catch { /* An unreadable pin must not prevent other runs migrating. */ }
      const status = workflowRunStatus(contract, start.card.toState, start.card.cancellation ? 'abandoned' : start.card.status);
      await db.query(`UPDATE messages SET card=card || jsonb_build_object('active',$2::boolean) WHERE id=$1`, [start.id, status === 'live']);
    }
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
