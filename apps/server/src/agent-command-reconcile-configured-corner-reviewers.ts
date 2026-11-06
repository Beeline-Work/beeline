import { subscribeConfiguredReviewers } from './agent-subscriptions.js';
import type { SqlDatabase } from './database.js';
import { advanceCorner } from './corner-lifecycle.js';



export async function reconcileConfiguredCornerReviewers(db: SqlDatabase, parentRoomId?: string): Promise<{ subscriptions: number; commands: number }> {
  const subscriptions = await subscribeConfiguredReviewers(db, [parentRoomId ?? null]);
  const corners = (await db.query<{ id: string }>(`SELECT id FROM rooms WHERE parent_id IS NOT NULL AND archived_at IS NULL
    AND ($1::uuid IS NULL OR parent_id=$1)`, [parentRoomId ?? null])).rows;
  let commands = 0;
  for (const corner of corners) if ((await advanceCorner(db, corner.id, { kind: 'reconcile' })).wake?.queued) commands++;
  return { subscriptions: subscriptions.rowCount, commands };
}
