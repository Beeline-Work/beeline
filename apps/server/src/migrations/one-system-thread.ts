import { createHash } from 'node:crypto';
import { CONNECTOR_KINDS } from '@beeline/api-contract/workbench';
import { SYSTEM_IDENTITY_ID, DELETED_ACCOUNT_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from '../database.js';
import { ensureSystemIdentity } from '../system-line.js';

/** Retire bot ledgers and their contents. New notices use @System exclusively. */
export async function retireBotDirectMessages(database: SqlDatabase): Promise<void> {
  await database.transaction(async db => {
    await ensureSystemIdentity(db);
    // Internal human identities (review/scheduler included) must not hold DMs.
    // Deleted people are conversation history, not system bots.
    await db.query(`DELETE FROM rooms room WHERE room.direct_participants IS NOT NULL
      AND EXISTS (SELECT 1 FROM identities bot
        WHERE bot.kind='human' AND bot.hidden_from_roster
          AND bot.id<>$1 AND bot.id<>$2 AND room.direct_participants ? bot.id)`,
    [SYSTEM_IDENTITY_ID, DELETED_ACCOUNT_IDENTITY_ID]);

    const botIds = [...CONNECTOR_KINDS, 'composio'].map(type =>
      createHash('sha256').update(`beeline:connector-identity:${type}`).digest('hex'));
    // Retained shared-Room records keep their author and creator foreign keys
    // valid after the obsolete connector identities themselves are deleted.
    await db.query('UPDATE messages SET author_id=$1 WHERE author_id=ANY($2::text[])', [SYSTEM_IDENTITY_ID, botIds]);
    await db.query('UPDATE rooms SET created_by=$1 WHERE created_by=ANY($2::text[])', [SYSTEM_IDENTITY_ID, botIds]);
    await db.query('UPDATE agent_grants SET requested_by=$1 WHERE requested_by=ANY($2::text[])', [SYSTEM_IDENTITY_ID, botIds]);
    await db.query('UPDATE agent_grants SET decided_by=$1 WHERE decided_by=ANY($2::text[])', [SYSTEM_IDENTITY_ID, botIds]);
    await db.query('DELETE FROM identities WHERE id=ANY($1::text[])', [botIds]);
  });
}
