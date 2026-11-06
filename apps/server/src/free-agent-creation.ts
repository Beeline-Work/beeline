import type {SqlDatabase} from './database.js';

export const FREE_AGENT_CREATION_SCHEMA=`
CREATE TABLE IF NOT EXISTS free_agent_creation_budget (
  owner_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  agents bigint NOT NULL CHECK(agents>=0)
);
`;

/** Reserve the configured funded Machine allowance, including a whole team.
 * Existing creations seed the first reservation; concurrent owners of the
 * same account increment its current counter rather than a stale count. */
export async function reserveStarterAgents(database:SqlDatabase,owner:string,count:1|2,limit:number):Promise<boolean>{
  const reserved=await database.query(`INSERT INTO free_agent_creation_budget(owner_id,agents)
    SELECT $1,count(*)+$2::bigint FROM free_agents WHERE owner_id=$1 HAVING count(*)+$2::bigint<=$3
    ON CONFLICT(owner_id) DO UPDATE SET agents=free_agent_creation_budget.agents+$2::bigint
      WHERE free_agent_creation_budget.agents+$2::bigint<=$3 RETURNING owner_id`,[owner,count,limit]);
  return Boolean(reserved.rowCount);
}

/** A losing per-Workspace Luna claim never spends a funded Machine slot. */
export async function refundStarterAgent(database:SqlDatabase,owner:string):Promise<void>{
  await database.query('UPDATE free_agent_creation_budget SET agents=agents-1 WHERE owner_id=$1',[owner]);
}
