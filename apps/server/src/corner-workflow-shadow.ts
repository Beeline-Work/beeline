import type { SqlDatabase } from './database.js';

export type CornerShadowEvent = 'checks-failed' | 'checks-passed' | 'review-ended';

/** The code-corner workflow's routing projection. The existing router stays authoritative. */
export function codeCornerShadowRecipient(input: {
  event: CornerShadowEvent;
  implementerId: string;
  reviewerId: string | null;
  reviewerReachable: boolean;
  checksPassing: boolean;
  handbacks: number;
}): string | null {
  if (input.event === 'checks-failed') return input.implementerId;
  if (input.event === 'checks-passed')
    return input.reviewerId && input.reviewerReachable
      ? input.reviewerId
      : input.reviewerId
        ? null
        : input.implementerId;
  return input.checksPassing && input.handbacks <= 3 ? input.implementerId : null;
}

export async function recordCodeCornerShadowWake(
  db: SqlDatabase,
  input: {
    cornerId: string;
    eventId: string;
    event: CornerShadowEvent;
    implementerId: string;
    reviewerId: string | null;
    reviewerReachable: boolean;
    checksPassing: boolean;
    handbacks: number;
    headSha: string | null;
    actualAgentId: string | null;
  },
): Promise<void> {
  const predicted = codeCornerShadowRecipient(input);
  await db.query(
    `INSERT INTO workflow_corner_shadow(corner_id,event_id,cause,head_sha,predicted_agent_id,actual_agent_id,disagrees)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(corner_id,event_id,cause) DO NOTHING`,
    [
      input.cornerId,
      input.eventId,
      input.event,
      input.headSha,
      predicted,
      input.actualAgentId,
      predicted !== input.actualAgentId,
    ],
  );
}

export async function existingCornerWake(
  db: SqlDatabase,
  cornerId: string,
  sourceMessageId: string,
  agentId: string,
): Promise<string | null> {
  const row = await db.query(
    `SELECT 1 FROM agent_commands WHERE room_id=$1
    AND source_message_id=$2 AND agent_id=$3 AND action='input'
    AND state<>'cancelled' LIMIT 1`,
    [cornerId, sourceMessageId, agentId],
  );
  return row.rowCount ? agentId : null;
}
