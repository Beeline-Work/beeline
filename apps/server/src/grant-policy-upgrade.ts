import type { SqlDatabase } from './database.js';
import { ensureSystemDirectMessageRoom } from './system-line.js';

/** Narrow old approvals to the new policy; never infer consent or requester provenance. */
export async function upgradeGrantPolicy(database: SqlDatabase): Promise<void> {
  await database.transaction(async (db) => {
    await db.query(`UPDATE agent_grants g SET status='revoked'
      FROM agents a WHERE a.agent_id=g.agent_id AND g.status IN ('pending','approved','once')
      AND (g.kind='budget' OR NOT EXISTS (
        SELECT 1 FROM agent_commands c JOIN messages m ON m.id=c.root_source_message_id
        WHERE c.id=g.command_id AND c.agent_id=g.agent_id AND c.room_id=g.room_id
          AND m.author_id=g.requested_by
      ) OR (g.kind<>'repository' AND (
        (g.auto AND g.requested_by<>a.owner_id) OR
        (NOT g.auto AND g.status IN ('approved','once') AND g.decided_by IS DISTINCT FROM a.owner_id)
      )))`);

    // Before this policy all grant kinds were personal resources, so an old
    // coalesced card belongs to one resource owner. Preserve its id and source
    // Room so pending decisions still resume the original command.
    const cards = await db.query<{
      id: string;
      room_id: string;
      workspace_id: string;
      owner_id: string;
      card: { grants: Array<Record<string, unknown>>; sourceRoomId?: string };
    }>(`SELECT m.id,m.room_id,r.workspace_id,a.owner_id,m.card
      FROM messages m JOIN rooms r ON r.id=m.room_id
      JOIN agents a ON a.agent_id=m.card->'agent'->>'pubkey'
      WHERE m.card_type='grant-request' AND r.direct_participants IS NULL
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.card->'grants') e
          JOIN agent_grants g ON g.id::text=e->>'grantId' WHERE g.kind<>'repository')
      FOR UPDATE OF m`);
    for (const row of cards.rows) {
      const roomId = await ensureSystemDirectMessageRoom(db, row.workspace_id, row.owner_id);
      await db.query(`UPDATE messages SET room_id=$2,card=$3::jsonb WHERE id=$1`, [
        row.id,
        roomId,
        JSON.stringify({ ...row.card, sourceRoomId: row.card.sourceRoomId ?? row.room_id }),
      ]);
    }
    const receipts = await db.query<{ id: string; workspace_id: string; owner_id: string }>(
      `SELECT m.id,g.workspace_id,a.owner_id FROM messages m
       JOIN rooms r ON r.id=m.room_id
       JOIN agent_grants g ON g.id::text=m.card->>'grantId'
       JOIN agents a ON a.agent_id=g.agent_id
       WHERE m.card_type='grant-auto' AND g.kind<>'repository' AND r.direct_participants IS NULL`,
    );
    for (const receipt of receipts.rows) {
      const roomId = await ensureSystemDirectMessageRoom(
        db,
        receipt.workspace_id,
        receipt.owner_id,
      );
      await db.query(`UPDATE messages SET room_id=$2 WHERE id=$1`, [receipt.id, roomId]);
    }
    // A revoked legacy ask must not retain live approval buttons in its card.
    await db.query(`UPDATE messages m SET card=jsonb_set(m.card,'{grants}',(
      SELECT jsonb_agg(CASE WHEN g.status='revoked'
        THEN jsonb_set(e,'{status}','"revoked"'::jsonb) ELSE e END ORDER BY ordinal)
      FROM jsonb_array_elements(m.card->'grants') WITH ORDINALITY entries(e,ordinal)
      LEFT JOIN agent_grants g ON g.id::text=e->>'grantId'
    )) WHERE m.card_type='grant-request' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(m.card->'grants') e
      JOIN agent_grants g ON g.id::text=e->>'grantId'
      WHERE g.status='revoked' AND e->>'status'<>'revoked'
    )`);
  });
}
