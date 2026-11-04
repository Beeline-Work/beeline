import type { SqlDatabase } from './database.js';
import type { routerSourcePlan } from './router-source-plan.js';
import { readRouterCertificate } from './router-projections.js';

/** Canonical current/former DB audience, never held profile IDs. Former IDs
 * come only from the transactional source capture, including FK deletion. */
export async function readRouterProfileAudience(db:SqlDatabase,workspaceId:string,viewer:string,plan:ReturnType<typeof routerSourcePlan>){
  const rows=await db.query<{agent_id:string}>(`SELECT identity_id agent_id FROM memberships member
    JOIN identities person ON person.id=member.identity_id AND person.kind='agent'
    WHERE member.workspace_id=$1 AND member.room_id IS NULL AND member.removed_at IS NULL AND NOT person.hidden_from_roster
    UNION SELECT unnest($2::text[]) ORDER BY agent_id`,[workspaceId,[...plan.profiles]]);
  const values=[];
  for(const {agent_id:agentId}of rows.rows){
    const input={family:'agent-profile' as const,workspaceId,agentId};
    values.push({agentId,changed:plan.allProfiles||plan.profiles.has(agentId),authority:await readRouterCertificate(db,input,viewer)});
  }
  return values;
}
