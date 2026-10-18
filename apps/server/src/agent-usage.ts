import { readAgentUsage, type AgentUsage } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import { freeAgentBudgetReached, freeAgentLimitsFromEnv } from './free-agent-limits.js';

/** Plan snapshots never cross the owner boundary, including roster reads. */
export async function agentUsage(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
  viewerId?: string,
): Promise<AgentUsage | undefined> {
  return (await agentUsages(database, [agentId], viewerId)).get(agentId);
}

export async function agentUsages(
  database: Pick<SqlDatabase, 'query'>,
  agentIds: readonly string[],
  viewerId?: string,
): Promise<Map<string, AgentUsage>> {
  const result = new Map<string, AgentUsage>();
  if (!agentIds.length) return result;
  const rows = (
    await database.query<{
      agent_id: string;
      usage_snapshot: unknown;
      free_agent: boolean;
      tokens: string;
    }>(
      `SELECT a.agent_id,a.usage_snapshot,
       EXISTS(SELECT 1 FROM free_agents f WHERE f.agent_id=a.agent_id AND f.removed_at IS NULL) free_agent,
       COALESCE(u.tokens,0)::text tokens
     FROM agents a LEFT JOIN free_agent_usage u ON u.owner_id=a.owner_id AND u.day=(now() AT TIME ZONE 'UTC')::date
     WHERE a.agent_id=ANY($1::text[]) AND ($2::text IS NULL OR a.owner_id=$2)`,
      [agentIds, viewerId ?? null],
    )
  ).rows;
  // Paused means Beeline's shared daily free budget is spent; its dollar figure never leaves the server.
  const paused = rows.some((row) => row.free_agent)
    ? await freeAgentBudgetReached(database, freeAgentLimitsFromEnv(process.env).dailyBudgetUsd)
    : false;
  for (const row of rows) {
    if (row.free_agent) {
      const now = new Date();
      const configured = Number(process.env.BEELINE_FREE_AGENT_DAILY_TOKENS);
      result.set(row.agent_id, {
        updatedAt: Date.now() / 1000,
        windows: [],
        free: {
          used: Number(row.tokens),
          limit: Number.isFinite(configured) && configured > 0 ? configured : 1_000_000,
          resetsAt: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000,
          ...(paused ? { paused: true } : {}),
        },
      });
    } else {
      const usage = readAgentUsage(row.usage_snapshot);
      if (usage) result.set(row.agent_id, usage);
    }
  }
  return result;
}

export async function saveAgentUsage(
  database: SqlDatabase,
  agentId: string,
  input: unknown,
): Promise<void> {
  const usage = readAgentUsage(input);
  if (!usage || usage.free) throw new Error('invalid agent usage');
  await database.transaction(async (db) => {
    const row = (
      await db.query<{ usage_snapshot: unknown }>(
        `SELECT usage_snapshot FROM agents WHERE agent_id=$1 FOR UPDATE`,
        [agentId],
      )
    ).rows[0];
    const previous = readAgentUsage(row?.usage_snapshot);
    const windows = new Map(previous?.windows.map((w) => [w.rateLimitType, w]));
    // Cap helper timestamps at receipt time; older reports cannot replace newer windows.
    const updatedAt = Date.now() / 1000;
    for (const w of usage.windows) {
      const prior = windows.get(w.rateLimitType);
      const observedAt = Math.min(w.updatedAt, updatedAt);
      if (!prior || observedAt >= prior.updatedAt)
        windows.set(w.rateLimitType, { ...w, updatedAt: observedAt });
    }
    if (windows.size > 64) throw new Error('too many usage windows');
    await db.query(
      `UPDATE agents SET usage_snapshot=$2::jsonb,updated_at=now() WHERE agent_id=$1`,
      [
        agentId,
        JSON.stringify({
          updatedAt: windows.size && !usage.spend
            ? Math.max(...[...windows.values()].map((w) => w.updatedAt))
            : updatedAt,
          windows: [...windows.values()],
          ...(usage.context
            ? { context: usage.context }
            : previous?.context
              ? { context: previous.context }
              : {}),
          // OpenRouter reports the whole key at once, so the latest read replaces the last.
          ...(usage.spend ? { spend: usage.spend } : previous?.spend ? { spend: previous.spend } : {}),
        }),
      ],
    );
  });
}
