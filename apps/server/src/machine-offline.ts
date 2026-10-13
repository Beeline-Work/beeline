import type { SqlDatabase } from './database.js';

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
