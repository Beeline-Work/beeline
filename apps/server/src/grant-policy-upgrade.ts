import { createHash } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { ensureSystemDirectMessageRoom, systemLine } from './system-line.js';

function policyLineId(kind: 'resume' | 'notice', grantId: string): string {
  return createHash('sha256').update(`grant-policy-upgrade:${kind}:${grantId}`).digest('hex');
}

/** Narrow old approvals to the new policy; never infer consent or requester provenance. */
export async function upgradeGrantPolicy(database: SqlDatabase): Promise<void> {
  await database.transaction(async (db) => {
    const recorded = await db.query<{
      grant_id: string;
      agent_id: string;
      workspace_id: string;
      room_id: string;
      owner_id: string;
      command_id: string | null;
      kind: string;
      target: string;
      requested_by: string;
      previous_status: 'pending' | 'approved' | 'once' | null;
      recovered: boolean;
    }>(`WITH candidates AS (
      SELECT g.id grant_id,g.agent_id,g.workspace_id,g.room_id,a.owner_id,g.command_id,
        g.kind,g.target,g.requested_by,
        CASE WHEN g.status<>'revoked' THEN g.status
          WHEN g.decided_at IS NULL THEN 'pending'
          WHEN g.auto AND g.decided_by IS NULL THEN 'approved'
          ELSE NULL END previous_status,
        g.status='revoked' recovered,
        CASE WHEN g.kind='budget' THEN 'budget-retired'
          WHEN NOT EXISTS (
            SELECT 1 FROM agent_commands c JOIN messages m ON m.id=c.root_source_message_id
            WHERE c.id=g.command_id AND c.agent_id=g.agent_id AND c.room_id=g.room_id
              AND m.author_id=g.requested_by
          ) THEN 'missing-requester-provenance'
          WHEN g.auto AND g.requested_by<>a.owner_id THEN 'third-party-auto-resource'
          ELSE 'non-owner-resource-decision' END reason
      FROM agent_grants g JOIN agents a ON a.agent_id=g.agent_id
      WHERE (
        g.status IN ('pending','approved','once') OR
        (g.status='revoked' AND (
          g.decided_at IS NULL OR g.decided_by IS NULL
        ))
      ) AND (g.kind='budget' OR NOT EXISTS (
        SELECT 1 FROM agent_commands c JOIN messages m ON m.id=c.root_source_message_id
        WHERE c.id=g.command_id AND c.agent_id=g.agent_id AND c.room_id=g.room_id
          AND m.author_id=g.requested_by
      ) OR (g.kind<>'repository' AND (
        (g.auto AND g.requested_by<>a.owner_id) OR
        (NOT g.auto AND g.status IN ('approved','once') AND g.decided_by IS DISTINCT FROM a.owner_id)
      )))
    )
    INSERT INTO agent_grant_policy_revocations(
      grant_id,agent_id,workspace_id,room_id,owner_id,command_id,kind,target,requested_by,
      previous_status,reason,recovered
    ) SELECT grant_id,agent_id,workspace_id,room_id,owner_id,command_id,kind,target,
      requested_by,previous_status,reason,recovered FROM candidates
    ON CONFLICT(grant_id) DO NOTHING
    RETURNING grant_id,agent_id,workspace_id,room_id,owner_id,command_id,kind,target,
      requested_by,previous_status,recovered`);

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

    for (const grant of recorded.rows) {
      let turnDisposition: 'resumed' | 'cancelled' | 'not-active' | 'unrecoverable' | undefined;
      if (grant.previous_status === 'pending') {
        const command = grant.command_id
          ? (await db.query<{
              id: string;
              turn_request_id: string;
              root_author_id: string | null;
            }>(`SELECT command.id,command.turn_request_id,root.author_id root_author_id
              FROM agent_commands command
              LEFT JOIN messages root ON root.id=command.root_source_message_id
              WHERE command.id=$1 AND command.agent_id=$2 AND command.room_id=$3
              FOR UPDATE OF command`, [grant.command_id, grant.agent_id, grant.room_id])).rows[0]
          : undefined;
        if (command?.root_author_id === grant.requested_by) {
          await systemLine(db, {
            id: policyLineId('resume', grant.grant_id),
            roomId: grant.room_id,
            authorId: SYSTEM_IDENTITY_ID,
            subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: '@system' },
            verb: 'revoked a legacy grant for',
            object: `${grant.kind} ${grant.target}`,
            consequence: 'permission policy upgraded',
            kind: 'grant-decided',
            commandId: command.id,
            wakes: [grant.agent_id],
            cardType: 'grant-decision',
            card: { grantId: grant.grant_id, status: 'revoked' },
          });
          turnDisposition = 'resumed';
        } else if (command) {
          const cancelled = await db.query<{ turn_request_id: string }>(
            `UPDATE agent_commands SET state='cancelled',completed_at=now()
             WHERE id=$1 AND state IN ('pending','claimed') RETURNING turn_request_id`,
            [command.id],
          );
          if (cancelled.rowCount) {
            await db.query(
              `UPDATE agent_turns SET status='cancelled',created_at=now()
               WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 AND status='working'`,
              [grant.room_id, grant.agent_id, command.turn_request_id],
            );
            turnDisposition = 'cancelled';
          } else {
            turnDisposition = 'not-active';
          }
        } else {
          turnDisposition = 'unrecoverable';
        }
        await db.query(
          `UPDATE agent_grant_policy_revocations SET turn_disposition=$2 WHERE grant_id=$1`,
          [grant.grant_id, turnDisposition],
        );
      }

      const ownerPresent = await db.query(
        `SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
         AND identity_id=$2 AND removed_at IS NULL`,
        [grant.workspace_id, grant.owner_id],
      );
      if (ownerPresent.rowCount) {
        const roomId = await ensureSystemDirectMessageRoom(db, grant.workspace_id, grant.owner_id);
        await systemLine(db, {
          id: policyLineId('notice', grant.grant_id),
          roomId,
          authorId: SYSTEM_IDENTITY_ID,
          subject: { kind: 'agent', id: grant.agent_id, name: grant.agent_id },
          verb: 'had a legacy grant revoked',
          object: `${grant.kind} ${grant.target}`,
          consequence: 'permission policy upgraded; request it again if still needed',
        });
      }
    }

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
