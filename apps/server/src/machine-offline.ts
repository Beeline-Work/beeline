import { freeAgentReachableSql } from './free-agents.js';

/**
 * Current machine reachability for event-driven command admission.
 * A free starter agent's Machine is never offline in this sense: it sleeps,
 * and a pending wake starts it (`FreeAgentService.wake`).
 */
export function agentMachineOfflineSql(agentId: string): string {
  return `EXISTS (SELECT 1 FROM agents offline_agent
    WHERE offline_agent.agent_id=${agentId} AND offline_agent.machine_id IS NOT NULL
      AND NOT ${freeAgentReachableSql('offline_agent.agent_id')}
      AND NOT EXISTS (SELECT 1 FROM agents sibling
        JOIN agent_connections connection ON connection.agent_id=sibling.agent_id
        WHERE sibling.owner_id=offline_agent.owner_id AND sibling.machine_id=offline_agent.machine_id
          AND connection.released_at IS NULL))`;
}
