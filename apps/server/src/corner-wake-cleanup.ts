import type { SqlDatabase } from './database.js';

/** Remove wake sources in the caller's corner archival transaction. */
export async function deleteCornerWakeSources(database: SqlDatabase, cornerIds: string[]): Promise<void> {
  await database.query(`DELETE FROM agent_schedules WHERE room_id=ANY($1::uuid[])`, [cornerIds]);
  await database.query(`DELETE FROM agent_subscriptions WHERE room_id=ANY($1::uuid[])`, [cornerIds]);
  await database.query(`DELETE FROM work_schedules WHERE room_id=ANY($1::uuid[])`, [cornerIds]);
  await database.query(
    `UPDATE corner_person_state SET event_subscriptions='[]'::jsonb
     WHERE corner_id=ANY($1::uuid[]) AND event_subscriptions IS DISTINCT FROM '[]'::jsonb`,
    [cornerIds],
  );
}
