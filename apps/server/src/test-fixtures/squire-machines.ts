import type { SqlDatabase } from '../database.js';
import { ensureSquireMachine, type SquireMachineState } from '../squire-machine.js';

/** Seed the canonical machine fact, keeping helper-local inboxes independent. */
export async function seedSquireMachine(database: SqlDatabase, agentId: string,
  patch: Partial<Pick<SquireMachineState, 'generation' | 'squire_work' | 'squire_report'>>): Promise<void> {
  const agent = (await database.query<{ owner_id: string; machine_id: string }>(
    'SELECT owner_id,COALESCE(machine_id,agent_id) machine_id FROM agents WHERE agent_id=$1', [agentId])).rows[0]!;
  const source = await ensureSquireMachine(database, agent.owner_id, agent.machine_id);
  await database.query(`UPDATE squire_machines SET generation=$3,squire_work=$4::jsonb,squire_report=$5::jsonb,
    helper_agent_id=$6,revision=revision+1 WHERE owner_id=$1 AND machine_id=$2`,
  [agent.owner_id, agent.machine_id, patch.generation ?? source.generation,
    JSON.stringify(patch.squire_work ?? source.squire_work), JSON.stringify(patch.squire_report === undefined ? source.squire_report : patch.squire_report), agentId]);
}
