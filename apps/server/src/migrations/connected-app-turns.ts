import type { SqlDatabase } from '../database.js';

/** Dispatch placeholders never prove that a connected app picked up work. */
export async function clearConnectedAppPlaceholders(db: SqlDatabase): Promise<void> {
  await db.query(`DELETE FROM agent_turns turn USING rooms_mcp_members app
    WHERE app.member_id=turn.agent_id AND turn.generation_id LIKE 'pending:%'`);
}
