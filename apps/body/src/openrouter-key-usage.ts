/**
 * Spend on an agent's own OpenRouter key, for the owner's Usage cell and the
 * agent's usage tool.
 *
 * `GET /api/v1/key` answers with the key's own spend (today, this week) and
 * its credit limit. Any agent key may read it; the account balance needs a
 * management key and is deliberately not read. The key stays in this process:
 * only the numbers are published. Reads happen after turns, at most once a
 * minute per key, never on an idle timer.
 */
import { createHash } from 'node:crypto';
import { openRouterModelId } from './openrouter-routing.js';
import type { AgentUsage, UsageSpend } from '@beeline/api-contract/daemon';

export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
export const OPENROUTER_KEY_MIN_INTERVAL_MS = 60_000;
const OPENROUTER_KEY_TIMEOUT_MS = 10_000;

const money = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;

/** The `/key` body reduced to spend figures; undefined when it is not a key read. */
export function openRouterKeySpend(body: unknown): UsageSpend | undefined {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== 'object') return undefined;
  const today = money(data.usage_daily);
  const week = money(data.usage_weekly);
  if (today === undefined || week === undefined) return undefined;
  const limit = money(data.limit);
  if (!limit) return { today, week };
  const remaining = typeof data.limit_remaining === 'number' && Number.isFinite(data.limit_remaining)
    ? Math.max(0, Math.round(data.limit_remaining * 100) / 100)
    : undefined;
  return {
    today,
    week,
    limit,
    ...(remaining !== undefined ? { remaining } : {}),
    // OpenRouter refuses the key's calls (402) once nothing is left.
    ...(remaining !== undefined && remaining <= 0 ? { rejected: true } : {}),
  };
}

/** The OpenRouter key this agent's turns spend, or undefined for any other model route. */
export function agentOpenRouterKey(
  agentKind: string | undefined,
  model: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  if (agentKind !== 'pi' && agentKind !== 'goose' && agentKind !== 'opencode') return undefined;
  // Free agents spend Beeline's proxy, whose figures the server already counts.
  if (env.BEELINE_FREE_AGENT_ID || env.BEELINE_FREE_AGENT_MODEL_TOKEN) return undefined;
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) return undefined;
  return openRouterModelId(model, env) || env.GOOSE_PROVIDER === 'openrouter' ? key : undefined;
}

const lastRead = new Map<string, number>();
const lastSpend = new Map<string, UsageSpend>();

async function fetchKeySpend(apiKey: string, fetchImpl: typeof fetch): Promise<UsageSpend | undefined> {
  try {
    const response = await fetchImpl(OPENROUTER_KEY_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(OPENROUTER_KEY_TIMEOUT_MS),
    });
    return response.ok ? openRouterKeySpend(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the key's spend and hand back a usage snapshot to publish, or nothing
 * when throttled or when OpenRouter does not answer with key figures.
 *
 * `refused` reports that OpenRouter refused a turn with 402. That is the stop
 * itself, so it is published at once. The throttle still bounds `/key` reads:
 * inside it, or when the read fails, the key's last figures (or none) carry
 * the reached mark.
 */
export async function readOpenRouterKeyUsage(
  apiKey: string,
  options: { fetchImpl?: typeof fetch; now?: () => number; refused?: boolean; force?: boolean } = {},
): Promise<AgentUsage | undefined> {
  const now = options.now?.() ?? Date.now();
  const id = createHash('sha256').update(apiKey).digest('hex');
  const throttled = !options.force && now - (lastRead.get(id) ?? -Infinity) < OPENROUTER_KEY_MIN_INTERVAL_MS;
  if (throttled && !options.refused) return undefined;
  let read: UsageSpend | undefined;
  if (!throttled) {
    lastRead.set(id, now);
    read = await fetchKeySpend(apiKey, options.fetchImpl ?? fetch);
    if (read) lastSpend.set(id, read);
  }
  const spend = options.refused ? { ...(read ?? lastSpend.get(id)), rejected: true } : read;
  return spend ? { updatedAt: now / 1000, windows: [], spend } : undefined;
}

/** Test hook: forget the per-key throttle and last figures. */
export function resetOpenRouterKeyThrottle(): void {
  lastRead.clear();
  lastSpend.clear();
}
