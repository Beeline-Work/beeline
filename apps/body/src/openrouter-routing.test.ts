import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { OPENROUTER_GLM_5_3_FLASH_ENDPOINTS } from './fixtures/openrouter-endpoints-glm-5.3-flash.js';
import {
  OPENROUTER_FALLBACK_PROVIDERS,
  OPENROUTER_ROUTING_CACHE_TTL_MS,
  openRouterModelId,
  openRouterRoutingInput,
  parseOpenRouterEndpoints,
  resolveOpenRouterRouting,
  selectReliableOpenRouterProviders,
  withOpenRouterModelRouting,
} from './openrouter-routing.js';

const MODEL = 'z-ai/glm-5.3-flash';

/**
 * Re-derived by hand from the recorded listing: every endpoint with `tools`,
 * context >= 1,048,576 (the window most endpoints advertise) and 30-minute
 * uptime >= 98, ordered by uptime desc (Morph and BaseTen tie at 100 and keep
 * listing order). GMICloud/Wafer/Parasail/Io Net fall to uptime, Together to
 * uptime AND a 1,048,575 window, Reka and StreamLake to context alone.
 */
const EXPECTED_PROVIDERS = [
  'morph',
  'baseten',
  'modal',
  'cloudflare',
  'fireworks',
  'novita',
  'makora',
  'deepinfra',
  'siliconflow',
  'nextbit',
  'friendli',
  'sail-research',
  'phala',
  'z-ai',
  'venice',
  'digitalocean',
];

const cleanup: string[] = [];
async function scratch(): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), 'beeline-openrouter-routing-'));
  cleanup.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchStub(payload: unknown = OPENROUTER_GLM_5_3_FLASH_ENDPOINTS) {
  return vi.fn(async () => jsonResponse(payload)) as unknown as typeof fetch & {
    mock: { calls: unknown[][] };
  };
}

describe('openRouterModelId', () => {
  it("strips pi's openrouter/ namespace", () => {
    expect(openRouterModelId('openrouter/z-ai/glm-5.3-flash')).toBe(MODEL);
  });
  it('accepts a bare vendor/model id only when the runtime holds an OpenRouter key', () => {
    expect(openRouterModelId(MODEL, { OPENROUTER_API_KEY: 'sk-or-x' })).toBe(MODEL);
    expect(openRouterModelId(MODEL, {})).toBeUndefined();
    expect(openRouterModelId('gpt-5.4', { OPENROUTER_API_KEY: 'sk-or-x' })).toBeUndefined();
    expect(openRouterModelId(undefined, { OPENROUTER_API_KEY: 'sk-or-x' })).toBeUndefined();
    expect(openRouterModelId('openrouter/', {})).toBeUndefined();
  });
});

describe('selectReliableOpenRouterProviders', () => {
  const parsed = parseOpenRouterEndpoints(OPENROUTER_GLM_5_3_FLASH_ENDPOINTS);

  it('derives the advertised context from the recorded listing', () => {
    expect(parsed.endpoints).toHaveLength(23);
    expect(parsed.contextLength).toBe(1_048_576);
  });

  it('keeps the tool-capable providers at ≥98% uptime, ordered by uptime', () => {
    const selection = selectReliableOpenRouterProviders(parsed.endpoints, parsed.contextLength);
    expect(selection.bar).toBe(98);
    expect(selection.providers).toEqual(EXPECTED_PROVIDERS);
    expect(selection.providers).not.toContain('gmicloud');
    expect(selection.providers).not.toContain('together');
    expect(selection.providers).not.toContain('reka');
    expect(selection.providers).not.toContain('streamlake');
  });

  it('drops a provider that does not accept tools even at perfect uptime', () => {
    const endpoints = parsed.endpoints.map((endpoint) =>
      endpoint.provider === 'morph' ? { ...endpoint, tools: false } : endpoint,
    );
    const selection = selectReliableOpenRouterProviders(endpoints, parsed.contextLength);
    expect(selection.providers[0]).toBe('baseten');
    expect(selection.providers).not.toContain('morph');
  });

  it('lowers the bar to 95 when fewer than two providers clear 98', () => {
    const endpoints = [
      { provider: 'a', uptime: 99, contextLength: 1000, tools: true },
      { provider: 'b', uptime: 96.5, contextLength: 1000, tools: true },
      { provider: 'c', uptime: 95, contextLength: 1000, tools: true },
      { provider: 'd', uptime: 94.9, contextLength: 1000, tools: true },
    ];
    expect(selectReliableOpenRouterProviders(endpoints, 1000)).toEqual({
      providers: ['a', 'b', 'c'],
      bar: 95,
      contextLength: 1000,
    });
  });

  it('reports no provider when nothing clears even the relaxed bar', () => {
    const endpoints = [{ provider: 'a', uptime: 90, contextLength: 1000, tools: true }];
    expect(selectReliableOpenRouterProviders(endpoints, 1000).providers).toEqual([]);
  });

  it('dedupes a provider serving the model on two endpoints', () => {
    const endpoints = [
      { provider: 'a', uptime: 99, contextLength: 1000, tools: true },
      { provider: 'a', uptime: 98.5, contextLength: 1000, tools: true },
      { provider: 'b', uptime: 98, contextLength: 1000, tools: true },
    ];
    expect(selectReliableOpenRouterProviders(endpoints, 1000).providers).toEqual(['a', 'b']);
  });
});

describe('resolveOpenRouterRouting', () => {
  it('asks the public endpoints API, pins the set with fallbacks inside it, and caches', async () => {
    const cacheDir = await scratch();
    const fetchImpl = fetchStub();
    const now = () => 1_000_000;
    const decision = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints',
    );
    expect(decision.source).toBe('live');
    expect(decision.routing).toEqual({
      only: EXPECTED_PROVIDERS,
      order: EXPECTED_PROVIDERS,
      allow_fallbacks: true,
      require_parameters: false,
    });
    expect(decision.line).toBe(
      `[body] openrouter routing for ${MODEL}: ${EXPECTED_PROVIDERS.join(', ')} (uptime ≥98%, tools)`,
    );
    const cached = JSON.parse(readFileSync(resolve(cacheDir, 'z-ai_glm-5.3-flash.json'), 'utf8'));
    expect(cached).toEqual({
      model: MODEL,
      fetchedAt: 1_000_000,
      providers: EXPECTED_PROVIDERS,
      bar: 98,
    });
  });

  it('serves a fresh cache without touching the network and refetches after 24h', async () => {
    const cacheDir = await scratch();
    const fetchImpl = fetchStub();
    let clock = 1_000_000;
    const now = () => clock;
    await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now });
    expect(fetchImpl.mock.calls).toHaveLength(1);

    clock += OPENROUTER_ROUTING_CACHE_TTL_MS - 1;
    const cached = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now });
    expect(cached.source).toBe('cache');
    expect(cached.providers).toEqual(EXPECTED_PROVIDERS);
    expect(cached.line).toContain('(uptime ≥98%, tools; cached)');
    expect(fetchImpl.mock.calls).toHaveLength(1);

    clock += 1;
    const refreshed = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now });
    expect(refreshed.source).toBe('live');
    expect(fetchImpl.mock.calls).toHaveLength(2);
  });

  it('falls back to the stale cache when the API is unreachable', async () => {
    const cacheDir = await scratch();
    const fetchImpl = fetchStub();
    await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now: () => 0 });
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const decision = await resolveOpenRouterRouting({
      model: MODEL,
      cacheDir,
      fetchImpl: down,
      now: () => OPENROUTER_ROUTING_CACHE_TTL_MS * 3,
    });
    expect(decision.source).toBe('stale-cache');
    expect(decision.providers).toEqual(EXPECTED_PROVIDERS);
    expect(decision.line).toContain('stale cache; api unreachable: ECONNREFUSED');
  });

  it("falls back to #840's pair with no cache and no API, and never throws", async () => {
    const cacheDir = resolve(await scratch(), 'missing');
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'nope' }, 503),
    ) as unknown as typeof fetch;
    const decision = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl });
    expect(decision.source).toBe('fallback');
    expect(decision.providers).toEqual([...OPENROUTER_FALLBACK_PROVIDERS]);
    expect(decision.routing.allow_fallbacks).toBe(true);
    expect(decision.line).toBe(
      `[body] openrouter routing for ${MODEL}: deepinfra, novita (fallback pair; api unreachable: HTTP 503)`,
    );
    expect(existsSync(cacheDir)).toBe(false);
  });

  it('uses the pair without caching when live data has no reliable provider', async () => {
    const cacheDir = await scratch();
    const payload = {
      data: {
        endpoints: [
          { tag: 'a', uptime_last_30m: 50, context_length: 1000, supported_parameters: ['tools'] },
        ],
      },
    };
    const decision = await resolveOpenRouterRouting({
      model: MODEL,
      cacheDir,
      fetchImpl: fetchStub(payload),
    });
    expect(decision.source).toBe('fallback');
    expect(decision.line).toContain('(fallback pair; no provider met the bar)');
    expect(existsSync(resolve(cacheDir, 'z-ai_glm-5.3-flash.json'))).toBe(false);
  });

  it('says so in the log line when the bar was lowered', async () => {
    const cacheDir = await scratch();
    const payload = {
      data: {
        endpoints: [
          {
            tag: 'a/fp8',
            uptime_last_30m: 99,
            context_length: 1000,
            supported_parameters: ['tools'],
          },
          { tag: 'b', uptime_last_30m: 96, context_length: 1000, supported_parameters: ['tools'] },
        ],
      },
    };
    const decision = await resolveOpenRouterRouting({
      model: MODEL,
      cacheDir,
      fetchImpl: fetchStub(payload),
    });
    expect(decision.providers).toEqual(['a', 'b']);
    expect(decision.line).toBe(
      `[body] openrouter routing for ${MODEL}: a, b (uptime ≥95%, tools; bar lowered: fewer than 2 providers at 98%)`,
    );
  });

  it('ignores a cache entry recorded for another model or with a broken shape', async () => {
    const cacheDir = await scratch();
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      resolve(cacheDir, 'z-ai_glm-5.3-flash.json'),
      JSON.stringify({ model: 'other/model', fetchedAt: Date.now(), providers: ['x'] }),
    );
    const fetchImpl = fetchStub();
    const decision = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl });
    expect(decision.source).toBe('live');
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });
});

describe('withOpenRouterModelRouting', () => {
  const routing = {
    only: ['a', 'b'],
    order: ['a', 'b'],
    allow_fallbacks: true,
    require_parameters: false,
  };

  it('pins one model through modelOverrides and leaves every other provider alone', () => {
    expect(
      withOpenRouterModelRouting(
        { providers: { local: { models: [] }, openrouter: { apiKey: 'k' } } },
        { model: MODEL, routing },
      ),
    ).toEqual({
      providers: {
        local: { models: [] },
        openrouter: {
          apiKey: 'k',
          modelOverrides: { [MODEL]: { compat: { openRouterRouting: routing } } },
        },
      },
    });
  });

  it('merges into an existing override for the model without dropping its other fields', () => {
    expect(
      withOpenRouterModelRouting(
        {
          providers: {
            openrouter: {
              modelOverrides: {
                [MODEL]: { name: 'GLM', compat: { supportsDeveloperRole: false } },
                'other/model': { name: 'Other' },
              },
            },
          },
        },
        { model: MODEL, routing },
      ),
    ).toEqual({
      providers: {
        openrouter: {
          modelOverrides: {
            [MODEL]: {
              name: 'GLM',
              compat: { supportsDeveloperRole: false, openRouterRouting: routing },
            },
            'other/model': { name: 'Other' },
          },
        },
      },
    });
  });

  it('adds nothing globally when no OpenRouter model is selected', () => {
    expect(withOpenRouterModelRouting({}, undefined)).toEqual({ providers: {} });
    expect(withOpenRouterModelRouting({ providers: { local: {} } }, undefined)).toEqual({
      providers: { local: {} },
    });
  });

  it('handles the legacy array provider form the same way', () => {
    expect(
      withOpenRouterModelRouting(
        { providers: [{ name: 'openrouter-ox', apiKey: 's' }] },
        { model: MODEL, routing },
      ),
    ).toEqual({
      providers: [
        { name: 'openrouter-ox', apiKey: 's' },
        {
          name: 'openrouter',
          modelOverrides: { [MODEL]: { compat: { openRouterRouting: routing } } },
        },
      ],
    });
  });
});

describe('openRouterRoutingInput', () => {
  it('names the model and cache dir only for an OpenRouter selection', () => {
    const config = { agentEnv: { OPENROUTER_API_KEY: 'k' }, openRouterRoutingCacheDir: '/cache' };
    expect(openRouterRoutingInput(config, { model: 'openrouter/z-ai/glm-5.3-flash' })).toEqual({
      openRouterRouting: { model: MODEL, cacheDir: '/cache' },
    });
    expect(openRouterRoutingInput(config, { model: 'claude-opus-4-1' })).toEqual({});
    expect(
      openRouterRoutingInput({ agentEnv: {} }, { model: 'openrouter/z-ai/glm-5.3-flash' }),
    ).toEqual({});
  });
});
