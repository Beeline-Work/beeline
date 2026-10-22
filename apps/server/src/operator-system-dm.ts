import { createHash, randomUUID } from 'node:crypto';
import type { CommandRow } from './agent-command.js';
import { CommandRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';
import type { FeedbackConfig } from './feedback.js';
import { sendSystemDirectMessage } from './system-line.js';

// Immutable operator identity; handles may change or be reassigned.
export const OPERATOR_OWNER_ID = '34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334';
export const OPERATOR_SYSTEM_DM_SCHEMA = `
CREATE TABLE IF NOT EXISTS operator_system_dm_sends (
 id uuid PRIMARY KEY, caller_id text NOT NULL, owner_id text NOT NULL,
 source_message_id text NOT NULL, recipients jsonb NOT NULL, text_hash text NOT NULL,
 text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 recipient_count integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS operator_system_dm_deliveries (
 send_id uuid NOT NULL REFERENCES operator_system_dm_sends(id),
 recipient_id text NOT NULL, workspace_id uuid,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','failed')),
 PRIMARY KEY(send_id,recipient_id)
);
CREATE INDEX IF NOT EXISTS operator_system_dm_pending ON operator_system_dm_deliveries(send_id,recipient_id)
 WHERE state='pending';
`;

async function authorize(database: SqlDatabase, config: FeedbackConfig, command: CommandRow | undefined, agentId: string) {
  if (!command || command.agent_id !== agentId) throw new CommandRefusalError('System DM requires an active owner command', 403);
  const actor = (await database.query<{ author_id: string }>(
    `SELECT m.author_id FROM messages m
     JOIN identities human ON human.id=m.author_id AND human.kind='human' AND NOT human.hidden_from_roster
     JOIN agents agent ON agent.agent_id=$2 AND agent.owner_id=human.id
     WHERE m.id=$1 AND human.id=$3`, [command.root_source_message_id, agentId, OPERATOR_OWNER_ID],
  )).rows[0];
  if (!actor || !config.systemSenders.includes(actor.author_id))
    throw new CommandRefusalError('System DM requires the operator owner’s human command and their own agent', 403);
  return actor.author_id;
}

async function operatorSystemDmStatus(database: SqlDatabase, sendId: string) {
  const row = (await database.query<{ recipients: number; delivered: number; failed: number; pending: number }>(
    `SELECT s.recipient_count recipients,
      count(*) FILTER(WHERE d.state='delivered')::int delivered,
      count(*) FILTER(WHERE d.state='failed')::int failed,
      count(*) FILTER(WHERE d.state='pending')::int pending
     FROM operator_system_dm_sends s LEFT JOIN operator_system_dm_deliveries d ON d.send_id=s.id
     WHERE s.id=$1 GROUP BY s.id`, [sendId],
  )).rows[0];
  if (!row) throw new CommandRefusalError('Unknown System DM send', 404);
  return { sendId, ...row };
}

export async function readOperatorSystemDm(database: SqlDatabase, config: FeedbackConfig, command: CommandRow | undefined,
  agentId: string, sendId: string) {
  await authorize(database, config, command, agentId);
  return operatorSystemDmStatus(database, sendId);
}

export async function sendOperatorSystemDm(database: SqlDatabase, config: FeedbackConfig, command: CommandRow | undefined,
  agentId: string, input: { recipients: string | readonly string[]; text: string }) {
  const owner = await authorize(database, config, command, agentId);
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16_000)
    throw new CommandRefusalError('message text must be 1 to 16000 characters', 400);
  const all = input.recipients === 'all';
  const names = typeof input.recipients === 'string' ? [input.recipients] : input.recipients;
  if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string' || !name.trim()))
    throw new CommandRefusalError('recipients must be a user id, exact handle, list, or all', 400);
  const selectors = [...new Set(names.map(name => name.replace(/^@/, '')))];
  const sendId = randomUUID();
  return database.transaction(async db => {
    if (!all) {
      const missing = await db.query(`SELECT selector FROM unnest($1::text[]) selector
        WHERE NOT EXISTS (SELECT 1 FROM identities i WHERE i.kind='human' AND NOT i.hidden_from_roster
          AND (i.id=selector OR i.handle=selector))`, [selectors]);
      if (missing.rowCount) throw new CommandRefusalError('Every recipient must resolve to an exact human user id or handle', 400);
    }
    await db.query(`INSERT INTO operator_system_dm_sends(id,caller_id,owner_id,source_message_id,recipients,text_hash,text)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [sendId, agentId, owner, command!.root_source_message_id, JSON.stringify(all ? 'all' : selectors),
        createHash('sha256').update(input.text).digest('hex'), input.text]);
    await db.query(`INSERT INTO operator_system_dm_deliveries(send_id,recipient_id,workspace_id,state)
      SELECT $1,i.id,w.workspace_id,CASE WHEN w.workspace_id IS NULL THEN 'failed' ELSE 'pending' END
      FROM identities i LEFT JOIN LATERAL (
        SELECT m.workspace_id FROM memberships m WHERE m.identity_id=i.id AND m.room_id IS NULL
          AND m.removed_at IS NULL ORDER BY m.joined_at,m.workspace_id LIMIT 1
      ) w ON true
      WHERE i.kind='human' AND NOT i.hidden_from_roster
        AND ($2::boolean OR i.id=ANY($3::text[]) OR i.handle=ANY($3::text[]))`, [sendId, all, selectors]);
    await db.query(`UPDATE operator_system_dm_sends SET recipient_count=
      (SELECT count(*) FROM operator_system_dm_deliveries WHERE send_id=$1) WHERE id=$1`, [sendId]);
    return operatorSystemDmStatus(db, sendId);
  });
}

/** Durable, bounded work on the background leader; each message and receipt commit together. */
export async function flushOperatorSystemDms(database: SqlDatabase) {
  let processed = 0;
  const started = Date.now();
  while (processed < 10 && Date.now() - started < 500) {
    const item = await database.transaction(async db => {
      const row = (await db.query<{ send_id: string; recipient_id: string; workspace_id: string | null; text: string }>(
        `SELECT d.send_id,d.recipient_id,d.workspace_id,s.text FROM operator_system_dm_deliveries d
         JOIN operator_system_dm_sends s ON s.id=d.send_id WHERE d.state='pending'
         ORDER BY d.send_id,d.recipient_id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
      )).rows[0];
      if (!row) return false;
      // A savepoint lets one failed recipient be recorded without rolling back its neighbours.
      await db.query('SAVEPOINT operator_dm_delivery');
      let state = 'delivered';
      try {
        if (!row.workspace_id) throw new Error('recipient has no active Workspace');
        await sendSystemDirectMessage(db, row.workspace_id, row.recipient_id, row.text,
          createHash('sha256').update(`operator-system-dm:${row.send_id}:${row.recipient_id}`).digest('hex'));
      } catch {
        await db.query('ROLLBACK TO SAVEPOINT operator_dm_delivery');
        state = 'failed';
      }
      await db.query('RELEASE SAVEPOINT operator_dm_delivery');
      await db.query(`UPDATE operator_system_dm_deliveries SET state=$3 WHERE send_id=$1 AND recipient_id=$2`,
        [row.send_id, row.recipient_id, state]);
      return true;
    });
    if (!item) break;
    processed++;
  }
  return processed;
}
