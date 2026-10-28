import { randomUUID } from 'node:crypto';
import {
  readAgentUsage,
  readUsageRefreshOutcome,
  usageReason,
  type AgentUsage,
  type UsageRefreshOutcome,
  type UsageWindow,
} from '@beeline/api-contract/daemon';
import { agentHelperOnline } from './agent-sign-in.js';
import type { SqlDatabase } from './database.js';
import { freeAgentDailyTokenCapFromEnv, freeAgentFirstDayTokenCapFromEnv, freeAgentLimitsFromEnv } from './free-agent-limits.js';
import type { LiveEvent, LiveHub } from './live.js';
import { POSTGRES_LIVE_CHANNEL } from './postgres-live.js';

/**
 * Plan usage belongs to an account, not an agent. A helper's quota-axi read
 * names its account (`AgentUsage.account`, a hash) and lands in one
 * `usage_accounts` row per owner, provider and account; each agent points at
 * the account it last read, so every agent on a login shows the same numbers.
 * The agent's own `usage_snapshot` keeps what is per agent (context, OpenRouter
 * key spend) and the numbers of agents that have not read an account yet.
 */

/** Usage inputs for an `agents` row, null unless `viewer` (a SQL expression) owns it. */
export function agentUsageColumns(agent: string, viewer: string): string {
  const owned = `${agent}.owner_id=${viewer}`;
  const today = `(now() AT TIME ZONE 'UTC')::date`;
  return `CASE WHEN ${owned} THEN ${agent}.usage_snapshot END usage_snapshot,
    CASE WHEN ${owned} THEN (SELECT ua.usage FROM usage_accounts ua
      WHERE ua.id=${agent}.usage_account_id AND ua.owner_id=${agent}.owner_id) END usage_account,
    CASE WHEN ${owned} THEN (SELECT array_agg(i.name ORDER BY lower(i.name),i.id)
      FROM agents o JOIN identities i ON i.id=o.agent_id
      WHERE o.usage_account_id=${agent}.usage_account_id AND o.agent_id<>${agent}.agent_id
        AND o.owner_id=${agent}.owner_id AND i.hidden_from_roster=false) END usage_shared_with,
    CASE WHEN ${owned} THEN ${agent}.machine_name END usage_machine,
    CASE WHEN ${owned} THEN EXISTS(SELECT 1 FROM free_agents f
      WHERE f.agent_id=${agent}.agent_id AND f.removed_at IS NULL) END usage_free,
    CASE WHEN ${owned} THEN (SELECT u.tokens::text FROM free_agent_usage u
      WHERE u.owner_id=${agent}.owner_id AND u.day=${today}) END usage_free_tokens,
    CASE WHEN ${owned} THEN (SELECT b.usd::text FROM free_agent_budget b
      WHERE b.day=${today}) END usage_free_budget_usd,
    CASE WHEN ${owned} THEN (SELECT COALESCE(now() < MIN(e.at) + interval '24 hours', true)
      FROM free_agent_events e JOIN free_agents ff ON ff.agent_id=e.agent_id
      WHERE ff.owner_id=${agent}.owner_id AND e.kind='model_usage') END usage_free_first_day`;
}

export type AgentUsageRow = {
  usage_snapshot?: unknown;
  usage_account?: unknown;
  usage_shared_with?: string[] | null;
  usage_machine?: string | null;
  usage_free?: boolean | null;
  usage_free_tokens?: string | null;
  usage_free_budget_usd?: string | null;
  usage_free_first_day?: boolean | null;
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
        limit: row.usage_free_first_day
          ? freeAgentFirstDayTokenCapFromEnv(process.env)
          : freeAgentDailyTokenCapFromEnv(process.env),
        resetsAt: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000,
        ...(paused ? { paused: true } : {}),
      },
    };
  }
  const own = readAgentUsage(row.usage_snapshot);
  // OpenRouter key spend is the agent's own; plan numbers come from its account.
  const account = own?.spend ? undefined : readAgentUsage(row.usage_account);
  const usage = account ? { ...account, ...(own?.context ? { context: own.context } : {}) } : own;
  if (!usage) return;
  const { account: _key, sharedWith: _shared, machine: _machine, ...shown } = usage;
  const sharedWith = account
    ? (row.usage_shared_with ?? []).map((name) => usageReason(name)).filter((name): name is string => !!name)
    : [];
  const machine = usageReason(row.usage_machine);
  return {
    ...shown,
    ...(sharedWith.length ? { sharedWith } : {}),
    ...(machine ? { machine } : {}),
  };
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

const oldest = (windows: readonly UsageWindow[]) =>
  windows.length ? Math.min(...windows.map((w) => w.updatedAt)) : undefined;

/** Per-window merge for partial reports (Claude's in-turn limits); older reports never replace newer windows. */
function mergeWindows(previous: AgentUsage | undefined, usage: AgentUsage, receivedAt: number): UsageWindow[] {
  const windows = new Map(previous?.windows.map((w) => [w.rateLimitType, w]));
  for (const w of usage.windows) {
    const prior = windows.get(w.rateLimitType);
    // Cap helper timestamps at receipt time.
    const observedAt = Math.min(w.updatedAt, receivedAt);
    if (!prior || observedAt >= prior.updatedAt) windows.set(w.rateLimitType, { ...w, updatedAt: observedAt });
  }
  if (windows.size > 64) throw new Error('too many usage windows');
  return [...windows.values()];
}

/**
 * An account record after one quota-axi read. A fresh read replaces the whole
 * window set; a cached (stale) one replaces it only when it is not older than
 * what is stored. Either way the record says how the latest read went.
 */
function applyAccountRead(previous: AgentUsage | undefined, usage: AgentUsage, receivedAt: number): AgentUsage {
  const windows = usage.windows.map((w) => ({ ...w, updatedAt: Math.min(w.updatedAt, receivedAt) }));
  const replace = usage.read?.status === 'fresh' ||
    (windows.length > 0 && oldest(windows)! >= (oldest(previous?.windows ?? []) ?? -Infinity));
  const kept = replace ? { windows, plan: usage.plan, credits: usage.credits }
    : { windows: previous?.windows ?? [], plan: previous?.plan, credits: previous?.credits };
  const read = usage.read ? { ...usage.read, at: Math.min(usage.read.at, receivedAt) } : previous?.read;
  return {
    updatedAt: oldest(kept.windows) ?? (replace ? Math.min(usage.updatedAt, receivedAt) : (previous?.updatedAt ?? receivedAt)),
    windows: kept.windows,
    ...(kept.plan ? { plan: kept.plan } : {}),
    ...(kept.credits ? { credits: kept.credits } : {}),
    ...(read ? { read } : {}),
  };
}

/** The plan part of a usage record, as an account stores it. */
const accountRecord = (usage: AgentUsage | undefined): AgentUsage => ({
  updatedAt: usage?.updatedAt ?? 0,
  windows: usage?.windows ?? [],
  ...(usage?.plan ? { plan: usage.plan } : {}),
  ...(usage?.credits ? { credits: usage.credits } : {}),
  ...(usage?.read ? { read: usage.read } : {}),
});

export async function saveAgentUsage(
  database: SqlDatabase,
  agentId: string,
  input: unknown,
): Promise<void> {
  const usage = readAgentUsage(input);
  if (!usage || usage.free) throw new Error('invalid agent usage');
  const receivedAt = Date.now() / 1000;
  await database.transaction(async (db) => {
    const agent = (
      await db.query<{ owner_id: string | null; usage_snapshot: unknown; usage_account_id: string | null }>(
        `SELECT owner_id,usage_snapshot,usage_account_id::text FROM agents WHERE agent_id=$1 FOR UPDATE`,
        [agentId],
      )
    ).rows[0];
    if (!agent) return;
    const previous = readAgentUsage(agent.usage_snapshot);
    const context = usage.context ?? previous?.context;
    const writeSnapshot = (snapshot: AgentUsage, accountId: string | null) =>
      db.query(
        `UPDATE agents SET usage_snapshot=$2::jsonb,usage_account_id=$3::bigint,updated_at=now() WHERE agent_id=$1`,
        [agentId, JSON.stringify({ ...snapshot, ...(context ? { context } : {}) }), accountId],
      );
    if (usage.spend) {
      // OpenRouter reports the whole key at once, so the latest read replaces the last.
      await writeSnapshot({ updatedAt: receivedAt, windows: [], spend: usage.spend }, null);
      return;
    }
    let account: { id: string; usage: unknown } | undefined;
    if (usage.account && agent.owner_id) {
      // A new account starts from this agent's own last numbers, so nothing flashes empty.
      const seed = previous?.spend ? undefined : previous;
      account = (
        await db.query<{ id: string; usage: unknown }>(
          `INSERT INTO usage_accounts(owner_id,provider,account_key,usage) VALUES($1,$2,$3,$4::jsonb)
           ON CONFLICT (owner_id,provider,account_key) DO UPDATE SET owner_id=EXCLUDED.owner_id
           RETURNING id::text,usage`,
          [agent.owner_id, usage.account.provider, usage.account.key, JSON.stringify(accountRecord(seed))],
        )
      ).rows[0];
    } else if (agent.usage_account_id) {
      account = (
        await db.query<{ id: string; usage: unknown }>(
          `SELECT id::text,usage FROM usage_accounts WHERE id=$1::bigint AND owner_id=$2 FOR UPDATE`,
          [agent.usage_account_id, agent.owner_id],
        )
      ).rows[0];
    }
    if (account) {
      const stored = readAgentUsage(account.usage);
      const next = usage.account
        ? applyAccountRead(stored, usage, receivedAt)
        : (() => {
            // Claude's in-turn limits update the account they were spent on.
            const windows = mergeWindows(stored, usage, receivedAt);
            return { ...accountRecord(stored), updatedAt: oldest(windows) ?? stored?.updatedAt ?? receivedAt, windows };
          })();
      await db.query(`UPDATE usage_accounts SET usage=$2::jsonb,updated_at=now() WHERE id=$1::bigint`, [
        account.id,
        JSON.stringify(next),
      ]);
      await writeSnapshot(previous && !previous.spend ? accountRecord(previous) : { updatedAt: receivedAt, windows: [] }, account.id);
      return;
    }
    const windows = mergeWindows(previous, usage, receivedAt);
    await writeSnapshot({
      // The stamp is the oldest number shown, never the newest.
      updatedAt: oldest(windows) ?? receivedAt,
      windows,
      // quota-axi reads the whole plan at once, so the latest read replaces the last.
      ...(usage.plan ? { plan: usage.plan } : previous?.plan ? { plan: previous.plan } : {}),
      ...(usage.credits ? { credits: usage.credits } : previous?.credits ? { credits: previous.credits } : {}),
      ...(usage.read ? { read: usage.read } : previous?.read ? { read: previous.read } : {}),
    }, null);
  });
}

export const USAGE_REFRESH_TABLE = 'agent_usage_refresh';
export const USAGE_REFRESH_RESULT_TABLE = 'agent_usage_refresh_result';
/** Longer than a practical helper read; the phone waits longer than this. */
export const USAGE_REFRESH_WAIT_MS = 20_000;
const REQUEST_ID = /^[0-9a-f-]{36}$/;
type UsageRefreshResult = Extract<LiveEvent, { type: 'usage-refresh-result' }>;

/** Decode one NOTIFY payload for the refresh result table; anything malformed is dropped. */
export function decodeUsageRefreshResult(raw: string): UsageRefreshResult | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const outcome = readUsageRefreshOutcome(parsed.outcome);
  if (parsed.table !== USAGE_REFRESH_RESULT_TABLE || typeof parsed.agentId !== 'string' || !outcome) return;
  if (parsed.requestId !== undefined && !(typeof parsed.requestId === 'string' && REQUEST_ID.test(parsed.requestId)))
    return;
  return {
    type: 'usage-refresh-result', roomId: '', agentId: parsed.agentId, outcome,
    ...(parsed.requestId ? { requestId: parsed.requestId as string } : {}),
  };
}

/**
 * Tell every server instance what a helper's read found. Without a request id
 * it answers any refresh waiting on that agent (helpers before request ids).
 */
export async function notifyUsageRefreshResult(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
  outcome: UsageRefreshOutcome,
  requestId?: string,
): Promise<void> {
  if (requestId !== undefined && !REQUEST_ID.test(requestId)) throw new Error('invalid usage refresh request');
  await database.query(`SELECT pg_notify($1, $2)`, [
    POSTGRES_LIVE_CHANNEL,
    JSON.stringify({
      table: USAGE_REFRESH_RESULT_TABLE, operation: 'UPDATE', roomId: '', agentId, outcome,
      ...(requestId ? { requestId } : {}),
    }),
  ]);
}

/** What a posted read found, for a refresh that waits on it. Context-only and in-turn updates say nothing. */
export function postedRefreshOutcome(input: unknown): UsageRefreshOutcome | undefined {
  const usage = readAgentUsage(input);
  if (!usage || !(usage.read || usage.spend || usage.plan || usage.credits)) return;
  return usage.read && usage.read.status !== 'fresh'
    ? {
        status: usage.read.status,
        ...(usage.read.reason ? { reason: usage.read.reason } : {}),
        ...(usage.read.retryAfter ? { retryAfter: usage.read.retryAfter } : {}),
      }
    : { status: 'fresh' };
}

/**
 * Ask the agent's helper to read its usage now and wait for what it found.
 * An agent whose machine holds no live connection answers `offline` at once.
 */
export async function requestUsageRefresh(
  database: Pick<SqlDatabase, 'query'>,
  live: LiveHub | undefined,
  agentId: string,
  options: { timeoutMs?: number } = {},
): Promise<UsageRefreshOutcome> {
  if (!(await agentHelperOnline(database, agentId))) return { status: 'offline' };
  const requestId = randomUUID();
  let release = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Subscribe before asking, so a fast helper cannot answer into the void.
  const answer = live
    ? new Promise<UsageRefreshOutcome>((resolve) => {
        release = live.subscribeAll((event) => {
          if (event.type === 'usage-refresh-result' && event.agentId === agentId &&
              (event.requestId === undefined || event.requestId === requestId))
            resolve(event.outcome);
        });
        timer = setTimeout(() => resolve({ status: 'no_answer' }), options.timeoutMs ?? USAGE_REFRESH_WAIT_MS);
        timer.unref?.();
      })
    : Promise.resolve<UsageRefreshOutcome>({ status: 'no_answer' });
  try {
    await database.query(`SELECT pg_notify($1, $2)`, [
      POSTGRES_LIVE_CHANNEL,
      JSON.stringify({ table: USAGE_REFRESH_TABLE, operation: 'UPDATE', roomId: '', agentId, requestId }),
    ]);
    return await answer;
  } finally {
    release();
    if (timer) clearTimeout(timer);
  }
}
