import { cornerReviewerSql, cornerReviewerFallbacksSql } from './corner-reviewer.js';
import type { AgentMemberMetadata } from '@beeline/api-contract/daemon';
import { AGENT_REACHABLE_HORIZON_MS } from '@beeline/api-contract/agent-access';
import type { SqlDatabase } from './database.js';
import { agentUsageColumns, projectAgentUsage, type AgentUsageRow } from './agent-usage.js';

/** Enrich authorized member lists with public owner and host display facts. */
export async function agentMemberMetadata<T extends {
  kind: 'human' | 'agent'; id?: string; identityId?: string;
}>(database: SqlDatabase, members: readonly T[], roomId?: string): Promise<(T & AgentMemberMetadata)[]> {
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
  // Only the membership-authorized Room read exposes billing and allowance.
  const details = roomId ? await database.query<AgentUsageRow & {
    agent_id: string; selected_model: string | null;
    reviewer_agent_id: string | null; reviewer_fallback_ids: string[];
  }>(`SELECT a.agent_id,a.selected_model,${agentUsageColumns('a', 'a.owner_id')},
       ${cornerReviewerSql('room')} reviewer_agent_id,${cornerReviewerFallbacksSql('room')} reviewer_fallback_ids
     FROM agents a CROSS JOIN rooms room
     JOIN rooms parent ON parent.id=COALESCE(room.parent_id,room.id)
     WHERE room.id=$1 AND a.agent_id=ANY($2::text[])`, [roomId, ids]) : undefined;
  const privateDetails = new Map(details?.rows.map(row => [row.agent_id, row]));
  return members.map(member => {
    if (member.kind !== 'agent') return member;
    const row = agents.get(member.id ?? member.identityId!);
    const detail = privateDetails.get(member.id ?? member.identityId!);
    const usage = detail ? projectAgentUsage(detail) : undefined;
    const windows = usage?.windows.flatMap(window => window.utilization === undefined ? [] : [{
      rateLimitType: window.rateLimitType,
      remaining: Math.max(0, 1 - window.utilization),
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    }]) ?? [];
    const billing = usage?.spend ? 'pay-per-use' as const
      : usage && (usage.plan || usage.windows.length || usage.credits) ? 'subscription' as const : undefined;
    const reviewer = detail && detail.reviewer_agent_id === member.id ? 'primary' as const
      : detail?.reviewer_agent_id && detail.reviewer_fallback_ids.includes(row?.agent_id ?? '')
        ? 'fallback' as const : undefined;
    return { ...member,
      ...(detail ? { model: detail.selected_model } : {}),
      ...(billing ? { billing } : {}),
      ...(usage && (windows.length || usage.spend?.remaining !== undefined || usage.credits || usage.free) ? {
        remainingAllowance: { updatedAt: usage.updatedAt, windows,
          ...(usage.spend?.remaining === undefined ? {} : { usd: usage.spend.remaining }),
          ...(usage.credits ? { credits: usage.credits.remaining } : {}),
          ...(usage.free ? { tokens: { remaining: Math.max(0, usage.free.limit - usage.free.used), resetsAt: usage.free.resetsAt } } : {}),
        },
      } : {}),
      ...(reviewer ? { reviewer } : {}),
      ...(row ? { owner: { id: row.owner_id, handle: row.owner_handle, name: row.owner_name } } : {}),
      machine: row?.machine_name ?? null,
      ...(row?.online != null ? { online: row.online } : {}),
    };
  });
}
