import { DEFAULT_WORKSPACE_ID } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';

/** Registration is a new delivery opportunity, not permission to replay chat.
 * Queue only the latest unread release in the person's existing announcement
 * DM. Its Room and message are unchanged. The normal worker owns delivery.
 */
export async function queueLatestReleasePush(
  database: SqlDatabase,
  identityId: string,
  token: string,
) {
  await database.query('DELETE FROM push_release_catchups WHERE device_token=$1', [token]);
  await database.query(
    `WITH latest AS (
       SELECT m.id,m.room_id,m.created_at FROM messages m
       JOIN rooms r ON r.id=m.room_id
       JOIN memberships member ON member.room_id=r.id AND member.identity_id=$1
         AND member.removed_at IS NULL
       WHERE m.author_id=$3 AND r.workspace_id=$4
         AND r.direct_participants @> jsonb_build_array($1::text,$3::text)
         AND m.card_type IS NULL
       ORDER BY m.created_at DESC,m.id DESC LIMIT 1
     )
     INSERT INTO push_release_catchups(device_token,identity_id,message_id)
     SELECT $2,$1,m.id FROM latest m
     LEFT JOIN room_read_marks read ON read.room_id=m.room_id AND read.identity_id=$1
     WHERE read.message_id IS NULL OR (m.created_at,m.id)>(read.message_created_at,read.message_id)`,
    [identityId, token, SYSTEM_IDENTITY_ID, DEFAULT_WORKSPACE_ID],
  );
  // A confirmed failed send may retry on an explicit registration opportunity.
  // Never clear delivered or in-flight claims, including a racing worker's.
  await database.query(
    `DELETE FROM push_delivery_claims claim USING push_release_catchups catchup
     WHERE catchup.device_token=$1 AND claim.device_token=catchup.device_token
       AND claim.message_id=catchup.message_id AND claim.status='failed'`,
    [token],
  );
}

export async function claimReleaseCatchup(
  database: SqlDatabase,
  messageId: string,
  token: string,
  identityId: string,
): Promise<boolean> {
  const claim = await database.query(
    `INSERT INTO push_delivery_claims(message_id,device_token,status)
     SELECT $1,$2,'claimed'
     WHERE EXISTS (
       SELECT 1
       FROM push_release_catchups catchup
       JOIN push_devices d ON d.token=catchup.device_token AND d.identity_id=catchup.identity_id
       JOIN messages m ON m.id=catchup.message_id
       JOIN rooms r ON r.id=m.room_id
       JOIN memberships member ON member.room_id=r.id AND member.identity_id=d.identity_id
         AND member.removed_at IS NULL
       LEFT JOIN room_read_marks read ON read.room_id=r.id AND read.identity_id=d.identity_id
       WHERE catchup.device_token=$2 AND catchup.identity_id=$3 AND catchup.message_id=$1
         AND (read.message_id IS NULL OR (m.created_at,m.id)>(read.message_created_at,read.message_id))
         AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.room_id=m.room_id
           AND newer.author_id=m.author_id AND newer.card_type IS NULL
           AND (newer.created_at,newer.id)>(m.created_at,m.id))
     ) ON CONFLICT DO NOTHING`,
    [messageId, token, identityId],
  );
  return Boolean(claim.rowCount);
}

export async function retireTerminalReleaseCatchups(database: SqlDatabase) {
  await database.query(
    `DELETE FROM push_release_catchups catchup
     WHERE NOT EXISTS (
       SELECT 1 FROM push_delivery_claims claim
       WHERE claim.device_token=catchup.device_token AND claim.message_id=catchup.message_id
         AND claim.status IN ('claimed','failed')
     )
     AND (
       EXISTS (
         SELECT 1 FROM push_delivery_claims claim
         WHERE claim.device_token=catchup.device_token AND claim.message_id=catchup.message_id
           AND claim.status='delivered'
       )
       OR NOT EXISTS (
         SELECT 1
         FROM push_devices d
         JOIN messages m ON m.id=catchup.message_id
         JOIN rooms r ON r.id=m.room_id
         JOIN memberships member ON member.room_id=r.id AND member.identity_id=d.identity_id
           AND member.removed_at IS NULL
         LEFT JOIN room_read_marks read ON read.room_id=r.id AND read.identity_id=d.identity_id
         WHERE d.token=catchup.device_token AND d.identity_id=catchup.identity_id
           AND (read.message_id IS NULL OR (m.created_at,m.id)>(read.message_created_at,read.message_id))
           AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.room_id=m.room_id
             AND newer.author_id=m.author_id AND newer.card_type IS NULL
             AND (newer.created_at,newer.id)>(m.created_at,m.id))
       )
     )`,
  );
}

/** One extra candidate lane; only this lane bypasses the registration floor.
 * Re-check readership, identity and latest-message status at dispatch time.
 */
export const RELEASE_CATCHUP_CANDIDATES_SQL = `
  SELECT m.id message_id,r.workspace_id::text workspace_id,
    COALESCE(r.parent_id,r.id)::text room_id,r.id::text channel_id,
    r.parent_id::text corner_id,'message' target,
    'message' notification_type,concat_ws(': ',author.name,btrim(m.text)) text,
    d.token,catchup.identity_id,true is_release_catchup,m.created_at
  FROM push_release_catchups catchup
  JOIN push_devices d ON d.token=catchup.device_token AND d.identity_id=catchup.identity_id
  JOIN messages m ON m.id=catchup.message_id
  JOIN rooms r ON r.id=m.room_id
  JOIN identities author ON author.id=m.author_id
  JOIN memberships member ON member.room_id=r.id AND member.identity_id=d.identity_id
    AND member.removed_at IS NULL
  LEFT JOIN room_read_marks read ON read.room_id=r.id AND read.identity_id=d.identity_id
  WHERE (read.message_id IS NULL OR (m.created_at,m.id)>(read.message_created_at,read.message_id))
    AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.room_id=m.room_id
      AND newer.author_id=m.author_id AND newer.card_type IS NULL
      AND (newer.created_at,newer.id)>(m.created_at,m.id))
`;
