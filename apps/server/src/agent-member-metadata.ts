import type { AgentMemberMetadata } from '@beeline/api-contract/daemon';
import { AGENT_REACHABLE_HORIZON_MS } from '@beeline/api-contract/agent-access';
import type { SqlDatabase } from './database.js';

/** Enrich authorized member lists with public owner and host display facts. */
export async function agentMemberMetadata<T extends {
  kind: 'human' | 'agent'; id?: string; identityId?: string;
}>(database: SqlDatabase, members: readonly T[]): Promise<(T & AgentMemberMetadata)[]> {
  const ids = members.filter(member => member.kind === 'agent')
    .map(member => member.id ?? member.identityId!);
  if (!ids.length) return [...members];
  const result = await database.query<{
    agent_id: string; owner_id: string; owner_handle: string | null;
    owner_name: string; machine_name: string | null; online: boolean | null;
  }>(
    `SELECT a.agent_id,owner.id owner_id,owner.handle owner_handle,owner.name owner_name,
       a.machine_name,
       (SELECT lo.body->>'status'='online' AND
          (lo.body->>'held'='true' OR lo.updated_at >= now()-make_interval(secs => $2::double precision / 1000))
        FROM live_outputs lo WHERE lo.agent_id=a.agent_id AND lo.kind='presence'
        ORDER BY lo.updated_at DESC LIMIT 1) online
     FROM agents a JOIN identities owner ON owner.id=a.owner_id
     WHERE a.agent_id=ANY($1::text[])`,
    [ids, AGENT_REACHABLE_HORIZON_MS],
  );
  const agents = new Map(result.rows.map(row => [row.agent_id, row]));
  return members.map(member => {
    if (member.kind !== 'agent') return member;
    const row = agents.get(member.id ?? member.identityId!);
    return { ...member,
      ...(row ? { owner: { id: row.owner_id, handle: row.owner_handle, name: row.owner_name } } : {}),
      machine: row?.machine_name ?? null,
      ...(row?.online != null ? { online: row.online } : {}),
    };
  });
}
