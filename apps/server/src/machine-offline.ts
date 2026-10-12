import type { SqlDatabase } from './database.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { ensureSystemDirectMessageRoom, systemLine } from './system-line.js';

interface MachineScope {
  owner_id: string;
  machine_id: string;
  machine_name: string | null;
}

/** Shared by wake suppression and the existing undelivered-command sweep. */
export function agentMachineOfflineSql(agentId: string): string {
  return `EXISTS (SELECT 1 FROM agents offline_agent
    WHERE offline_agent.agent_id=${agentId} AND offline_agent.machine_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM agents sibling
        JOIN agent_connections connection ON connection.agent_id=sibling.agent_id
        WHERE sibling.owner_id=offline_agent.owner_id AND sibling.machine_id=offline_agent.machine_id
          AND connection.released_at IS NULL))`;
}

/** Serialize connection changes for all agents belonging to one machine owner. */
export async function lockAgentMachine(db: SqlDatabase, agentId: string): Promise<MachineScope | undefined> {
  const scope = (await db.query<MachineScope>(
    `SELECT owner_id,machine_id,machine_name FROM agents
     WHERE agent_id=$1 AND owner_id IS NOT NULL AND machine_id IS NOT NULL`, [agentId],
  )).rows[0];
  if (scope) await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',
    [`machine-presence:${scope.owner_id}:${scope.machine_id}`]);
  return scope;
}

/** A reconnect settles the existing notice; the next disconnect can create another. */
export async function clearMachineOffline(db: SqlDatabase, scope: MachineScope | undefined): Promise<void> {
  if (!scope) return;
  await db.query(
    `UPDATE messages SET card=card || '{"status":"resolved"}'::jsonb
     WHERE card_type='machine-offline' AND card->>'machineId'=$1
       AND card->>'ownerId'=$2 AND card->>'status'='open'`,
    [scope.machine_id, scope.owner_id],
  );
}

/** Called by the existing disconnect path, never by a wake or a periodic scan. */
export async function noteMachineOffline(db: SqlDatabase, scope: MachineScope | undefined): Promise<void> {
  if (!scope) return;
  const connected = await db.query(
    `SELECT 1 FROM agents agent JOIN agent_connections connection ON connection.agent_id=agent.agent_id
     WHERE agent.owner_id=$1 AND agent.machine_id=$2 AND connection.released_at IS NULL LIMIT 1`,
    [scope.owner_id, scope.machine_id],
  );
  if (connected.rowCount) return;
  const existing = await db.query(
    `SELECT 1 FROM messages WHERE card_type='machine-offline' AND card->>'machineId'=$1
       AND card->>'ownerId'=$2 AND card->>'status'='open' LIMIT 1`,
    [scope.machine_id, scope.owner_id],
  );
  if (existing.rowCount) return;
  const agents = (await db.query<{ agent_id: string; handle: string | null; name: string }>(
    `SELECT agent.agent_id,identity.handle,identity.name FROM agents agent
     JOIN identities identity ON identity.id=agent.agent_id AND NOT identity.hidden_from_roster
     WHERE agent.owner_id=$1 AND agent.machine_id=$2
       AND EXISTS (SELECT 1 FROM memberships member WHERE member.identity_id=agent.agent_id
         AND member.removed_at IS NULL)
     ORDER BY identity.handle NULLS LAST,agent.agent_id`, [scope.owner_id, scope.machine_id],
  )).rows;
  if (!agents.length) return;
  // A machine may serve several Workspaces. One owner DM holds its one notice.
  const workspaceId = (await db.query<{ workspace_id: string }>(
    `SELECT member.workspace_id FROM memberships member
     JOIN memberships owner ON owner.workspace_id=member.workspace_id
       AND owner.identity_id=$2 AND owner.room_id IS NULL AND owner.removed_at IS NULL
     WHERE member.identity_id=ANY($1::text[]) AND member.removed_at IS NULL
     ORDER BY member.workspace_id LIMIT 1`, [agents.map(agent => agent.agent_id), scope.owner_id],
  )).rows[0]?.workspace_id;
  if (!workspaceId) return;
  const roomId = await ensureSystemDirectMessageRoom(db, workspaceId, scope.owner_id);
  const labels = agents.slice(0, 3).map(agent => agent.handle ? `@${agent.handle}` : agent.name);
  const names = labels.join(', ') + (agents.length > labels.length ? ` and ${agents.length - labels.length} more` : '');
  await systemLine(db, {
    roomId, authorId: SYSTEM_IDENTITY_ID,
    subject: { kind: 'system', name: `${scope.machine_name || 'This machine'}'s helper` },
    verb: 'went offline',
    consequence: `${names} can't respond`,
    cardType: 'machine-offline',
    card: { machineId: scope.machine_id, ownerId: scope.owner_id,
      agentIds: agents.map(agent => agent.agent_id), status: 'open' },
  });
}
