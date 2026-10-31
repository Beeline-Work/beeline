import type { SqlDatabase } from './database.js';

/** A real helper change can repair adapter rejection, without changing review wording or evidence. */
export async function recoverAdapterReviewsOnHelperChange(
  database: SqlDatabase,
  agentId: string,
  previous: Record<string, unknown> | undefined,
  current: { releaseVersion?: string; sourceSha?: string },
): Promise<void> {
  const changed = ['releaseVersion', 'sourceSha'].some(key => {
    const before = previous?.[key];
    const after = current[key as keyof typeof current];
    return typeof before === 'string' && before.length > 0 &&
      typeof after === 'string' && after.length > 0 && before !== after;
  });
  if (!changed) return;
  await database.query(
    `UPDATE agent_commands command SET review_context=review_context ||
       jsonb_build_object('helperRecoveredAt',clock_timestamp())
     WHERE command.agent_id=$1 AND command.state IN ('complete','cancelled')
       AND command.review_context->>'failureKind'='helper-out-of-date'
       AND NOT command.review_context ? 'helperRecoveredAt'
       AND EXISTS (SELECT 1 FROM agent_turns turn WHERE turn.agent_id=command.agent_id
         AND turn.room_id=command.room_id AND turn.request_id=command.turn_request_id
         AND turn.status='failed')`,
    [agentId],
  );
}
