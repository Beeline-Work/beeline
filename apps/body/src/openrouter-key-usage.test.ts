import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentOpenRouterKey,
  OPENROUTER_KEY_URL,
  openRouterKeySpend,
  readOpenRouterKeyUsage,
  resetOpenRouterKeyThrottle,
} from './openrouter-key-usage.js';

// Shape of a real `GET /api/v1/key` answer (openrouter.ai/docs/api-reference/limits).
const keyBody = (data: Record<string, unknown>) => ({
  data: {
    label: 'sk-or-v1-abc...xyz',
    limit: null,
    limit_reset: null,
    limit_remaining: null,
    include_byok_in_limit: false,
    usage: 120.5,
    usage_daily: 4.123,
    usage_weekly: 18.4,
    usage_monthly: 60,
    is_free_tier: false,
    ...data,
  },
});

describe('OpenRouter key spend', () => {
  beforeEach(() => resetOpenRouterKeyThrottle());

  it('maps an unlimited key to today and this week only', () => {
    expect(openRouterKeySpend(keyBody({}))).toEqual({ today: 4.12, week: 18.4 });
  });

  it('maps a key limit and marks it reached when nothing is left', () => {
    expect(openRouterKeySpend(keyBody({ limit: 20, limit_remaining: 15.88 }))).toEqual({
      today: 4.12, week: 18.4, limit: 20, remaining: 15.88,
    });
    expect(openRouterKeySpend(keyBody({ limit: 20, limit_remaining: -0.4 }))).toEqual({
      today: 4.12, week: 18.4, limit: 20, remaining: 0, rejected: true,
    });
    expect(openRouterKeySpend({ error: { code: 401 } })).toBeUndefined();
  });

  it('reads with the agent key, publishes only numbers, and waits a minute between reads', async () => {
    const fetchImpl = vi.fn(async () => Response.json(keyBody({ limit: 20, limit_remaining: 3.6 })));
    let now = 1_000_000;
    const first = await readOpenRouterKeyUsage('sk-or-secret', { fetchImpl, now: () => now });
    expect(fetchImpl).toHaveBeenCalledWith(OPENROUTER_KEY_URL, expect.objectContaining({
      headers: { authorization: 'Bearer sk-or-secret' },
    }));
    expect(first).toEqual({ updatedAt: 1000, windows: [], spend: { today: 4.12, week: 18.4, limit: 20, remaining: 3.6 } });
    expect(JSON.stringify(first)).not.toContain('sk-or');
    now += 30_000;
    expect(await readOpenRouterKeyUsage('sk-or-secret', { fetchImpl, now: () => now })).toBeUndefined();
    now += 31_000;
    await readOpenRouterKeyUsage('sk-or-secret', { fetchImpl, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('publishes a 402 refusal at once from the last figures, without a second key read inside a minute', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => Response.json(keyBody({ limit: 20, limit_remaining: 0.4 })));
    await readOpenRouterKeyUsage('sk-or-k', { fetchImpl, now: () => now });
    for (const step of [1_000, 1_000]) {
      now += step;
      expect(await readOpenRouterKeyUsage('sk-or-k', { fetchImpl, now: () => now, refused: true })).toEqual({
        updatedAt: now / 1000,
        windows: [],
        spend: { today: 4.12, week: 18.4, limit: 20, remaining: 0.4, rejected: true },
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('publishes a 402 refusal with no figures when the key read fails', async () => {
    const failing = vi.fn(async () => new Response('{}', { status: 503 }));
    const now = 1_000_000;
    expect(await readOpenRouterKeyUsage('sk-or-new', { fetchImpl: failing, now: () => now, refused: true }))
      .toEqual({ updatedAt: now / 1000, windows: [], spend: { rejected: true } });
    expect(await readOpenRouterKeyUsage('sk-or-new', { fetchImpl: failing, now: () => now + 1_000, refused: true }))
      .toEqual({ updatedAt: (now + 1_000) / 1000, windows: [], spend: { rejected: true } });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('answers nothing when OpenRouter refuses the read', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    expect(await readOpenRouterKeyUsage('sk-or-bad', { fetchImpl })).toBeUndefined();
  });

  it('only reads for API-key harnesses on an OpenRouter model', () => {
    const env = { OPENROUTER_API_KEY: 'sk-or-1' };
    expect(agentOpenRouterKey('pi', 'openrouter/deepseek/deepseek-v4', env)).toBe('sk-or-1');
    expect(agentOpenRouterKey('pi', 'deepseek/deepseek-v4', env)).toBe('sk-or-1');
    expect(agentOpenRouterKey('goose', undefined, { ...env, GOOSE_PROVIDER: 'openrouter' })).toBe('sk-or-1');
    expect(agentOpenRouterKey('claude', 'openrouter/x/y', env)).toBeUndefined();
    expect(agentOpenRouterKey('pi', 'gpt-6', env)).toBeUndefined();
    expect(agentOpenRouterKey('pi', 'x/y', { ...env, BEELINE_FREE_AGENT_ID: 'free' })).toBeUndefined();
  });
});
