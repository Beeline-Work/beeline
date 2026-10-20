import { readAgentUsage, type AgentUsage } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import { freeAgentDailyTokenCapFromEnv, freeAgentLimitsFromEnv } from './free-agent-limits.js';

/** Usage inputs for an `agents` row, null unless `viewer` (a SQL expression) owns it. */
export function agentUsageColumns(agent: string, viewer: string): string {
  const owned = `${agent}.owner_id=${viewer}`;
  const today = `(now() AT TIME ZONE 'UTC')::date`;
  return `CASE WHEN ${owned} THEN ${agent}.usage_snapshot END usage_snapshot,
    CASE WHEN ${owned} THEN EXISTS(SELECT 1 FROM free_agents f
      WHERE f.agent_id=${agent}.agent_id AND f.removed_at IS NULL) END usage_free,
    CASE WHEN ${owned} THEN (SELECT u.tokens::text FROM free_agent_usage u
      WHERE u.owner_id=${agent}.owner_id AND u.day=${today}) END usage_free_tokens,
    CASE WHEN ${owned} THEN (SELECT b.usd::text FROM free_agent_budget b
      WHERE b.day=${today}) END usage_free_budget_usd`;
}

export type AgentUsageRow = {
  usage_snapshot?: unknown;
  usage_free?: boolean | null;
  usage_free_tokens?: string | null;
  usage_free_budget_usd?: string | null;
};

/**
 * The owner's usage for one row read with `agentUsageColumns`. A free agent's
 * paused state is derived from Beeline's shared budget, whose dollar figure
 * never leaves the server.
 */
export function projectAgentUsage(row: AgentUsageRow): AgentUsage | undefined {
  if (row.usage_free) {
    const now = new Date();
    const paused =
      Number(row.usage_free_budget_usd ?? 0) >= freeAgentLimitsFromEnv(process.env).dailyBudgetUsd;
    return {
      updatedAt: Date.now() / 1000,
      windows: [],
      free: {
        used: Number(row.usage_free_tokens ?? 0),
        limit: freeAgentDailyTokenCapFromEnv(process.env),
        resetsAt: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000,
        ...(paused ? { paused: true } : {}),
      },
    };
  }
  return readAgentUsage(row.usage_snapshot);
}

/** An agent's own usage, for its usage tool. */
export async function agentUsage(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
): Promise<AgentUsage | undefined> {
  const row = (
    await database.query<AgentUsageRow>(
      `SELECT ${agentUsageColumns('a', 'a.owner_id')} FROM agents a WHERE a.agent_id=$1`,
      [agentId],
    )
  ).rows[0];
  return row ? projectAgentUsage(row) : undefined;
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
