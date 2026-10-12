import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { OPENROUTER_GLM_5_3_FLASH_ENDPOINTS } from './fixtures/openrouter-endpoints-glm-5.3-flash.js';
import {
  OPENROUTER_FALLBACK_PROVIDERS,
  OPENROUTER_MAX_OUTPUT_TOKENS,
  OPENROUTER_PROBE_CACHE_TTL_MS,
  OPENROUTER_ROUTING_CACHE_TTL_MS,
  openRouterModelId,
  openRouterModelLimits,
  openRouterRoutingInput,
  openRouterRoutingFor,
  rankOpenRouterProviders,
  parseOpenRouterEndpoints,
  piInputModalities,
  probeOpenRouterProviders,
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
      { provider: 'a', uptime: 99, contextLength: 1000, maxCompletionTokens: 0, tools: true },
      { provider: 'b', uptime: 96.5, contextLength: 1000, maxCompletionTokens: 0, tools: true },
      { provider: 'c', uptime: 95, contextLength: 1000, maxCompletionTokens: 0, tools: true },
      { provider: 'd', uptime: 94.9, contextLength: 1000, maxCompletionTokens: 0, tools: true },
    ];
    expect(selectReliableOpenRouterProviders(endpoints, 1000)).toEqual({
      providers: ['a', 'b', 'c'],
      bar: 95,
      contextLength: 1000,
    });
  });

  it('reports no provider when nothing clears even the relaxed bar', () => {
    const endpoints = [{ provider: 'a', uptime: 90, contextLength: 1000, maxCompletionTokens: 0, tools: true }];
    expect(selectReliableOpenRouterProviders(endpoints, 1000).providers).toEqual([]);
  });

  it('dedupes a provider serving the model on two endpoints', () => {
    const endpoints = [
      { provider: 'a', uptime: 99, contextLength: 1000, maxCompletionTokens: 0, tools: true },
      { provider: 'a', uptime: 98.5, contextLength: 1000, maxCompletionTokens: 0, tools: true },
      { provider: 'b', uptime: 98, contextLength: 1000, maxCompletionTokens: 0, tools: true },
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
      allow_fallbacks: true,
      require_parameters: false,
    });
    expect(decision.line).toBe(
      `[body] openrouter routing for ${MODEL}: ${EXPECTED_PROVIDERS.join(', ')} (uptime ≥98%, tools)`,
    );
    // C87: the listing's own input modalities ride with the pin.
    expect(decision.input).toEqual(['text', 'image']);
    expect(decision.limits).toEqual({ contextWindow: 1_048_576, maxTokens: 32_768 });
    const cached = JSON.parse(readFileSync(resolve(cacheDir, 'z-ai_glm-5.3-flash.json'), 'utf8'));
    expect(cached).toEqual({
      policy: 'cache-sticky-v1',
      model: MODEL,
      fetchedAt: 1_000_000,
      providers: EXPECTED_PROVIDERS,
      bar: 98,
      input: ['text', 'image'],
      limits: { contextWindow: 1_048_576, maxTokens: 32_768 },
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
      `[body] openrouter routing for ${MODEL}: a, b (uptime ≥95%, tools; bar lowered: reliability fallback or cache continuity)`,
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

  // C87. An operator custom-model entry REPLACES pi's catalog record for that
  // id and pi defaults a definition without `input` to ["text"], which makes
  // pi rewrite every image block to "(image omitted: model does not support
  // images)" before the request leaves the process. The override layer, which
  // is applied last, is where the live modalities have to land.
  it('pins the model input modalities on the same override as the routing', () => {
    const composed = withOpenRouterModelRouting(
      {
        providers: {
          openrouter: {
            baseUrl: 'https://egress.example/v1',
            models: [{ id: MODEL, reasoning: true, contextWindow: 98304 }],
          },
        },
      },
      { model: MODEL, routing, input: ['text', 'image'] },
    ) as any;
    // The operator's own custom-model definition is untouched...
    expect(composed.providers.openrouter.models).toEqual([
      { id: MODEL, reasoning: true, contextWindow: 98304 },
    ]);
    // ...and the topmost layer restores what it dropped.
    expect(composed.providers.openrouter.modelOverrides[MODEL]).toEqual({
      compat: { openRouterRouting: routing },
      input: ['text', 'image'],
    });
  });

  it('leaves input alone when the decision could not name the modalities', () => {
    const composed = withOpenRouterModelRouting({}, { model: MODEL, routing }) as any;
    expect(composed.providers.openrouter.modelOverrides[MODEL]).toEqual({
      compat: { openRouterRouting: routing },
    });
  });

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

describe('the model input modalities the pin carries (C87)', () => {
  it('reads them from the same endpoints listing, in pi vocabulary', () => {
    const parsed = parseOpenRouterEndpoints(OPENROUTER_GLM_5_3_FLASH_ENDPOINTS);
    expect(parsed.inputModalities).toEqual(['text', 'image', 'video']);
    // pi's config schema knows only text and image; video is dropped, not passed through.
    expect(piInputModalities(parsed.inputModalities)).toEqual(['text', 'image']);
    expect(piInputModalities(['text'])).toEqual(['text']);
    expect(piInputModalities(undefined)).toBeUndefined();
  });

  it('leaves input alone when the listing names no modalities', () => {
    const { data, ...rest } = OPENROUTER_GLM_5_3_FLASH_ENDPOINTS as Record<string, any>;
    const { architecture: _architecture, ...withoutArchitecture } = data;
    expect(parseOpenRouterEndpoints({ ...rest, data: withoutArchitecture }).inputModalities).toBeUndefined();
  });

  it('carries them through cache, stale cache and a one-provider override', async () => {
    const cacheDir = await scratch();
    const fetchImpl = fetchStub();
    let clock = 1_000_000;
    const now = () => clock;
    await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now });

    clock += 1;
    const cached = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now });
    expect(cached.source).toBe('cache');
    expect(cached.input).toEqual(['text', 'image']);

    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    clock += OPENROUTER_ROUTING_CACHE_TTL_MS;
    const stale = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl: down, now });
    expect(stale.source).toBe('stale-cache');
    expect(stale.input).toEqual(['text', 'image']);

    const pinned = await resolveOpenRouterRouting({
      model: MODEL,
      cacheDir,
      fetchImpl: down,
      now,
      providerOverride: 'baseten',
    });
    expect(pinned.providers).toEqual(['baseten']);
    expect(pinned.input).toEqual(['text', 'image']);
  });

  it('records "the listing named none" so a modality-less model is not re-asked every activation', async () => {
    const cacheDir = await scratch();
    const { data, ...rest } = OPENROUTER_GLM_5_3_FLASH_ENDPOINTS as Record<string, any>;
    const { architecture: _architecture, ...withoutArchitecture } = data;
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ...rest, data: withoutArchitecture })),
    ) as unknown as typeof fetch;
    let clock = 1_000_000;
    const now = () => clock;

    const live = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now });
    expect(live.source).toBe('live');
    expect(live.input).toBeUndefined();
    expect(
      JSON.parse(readFileSync(resolve(cacheDir, 'z-ai_glm-5.3-flash.json'), 'utf8')).input,
    ).toBeNull();

    clock += 1;
    const cached = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now });
    expect(cached.source).toBe('cache');
    expect(cached.input).toBeUndefined();
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it('re-asks rather than trusting a cache entry written before the modalities were recorded', async () => {
    const cacheDir = await scratch();
    const fetchImpl = fetchStub();
    const now = () => 1_000_000;
    writeFileSync(
      resolve(cacheDir, 'z-ai_glm-5.3-flash.json'),
      JSON.stringify({ model: MODEL, fetchedAt: 1_000_000, providers: ['baseten'], bar: 98 }),
    );
    const decision = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now });
    expect(decision.source).toBe('live');
    expect(decision.input).toEqual(['text', 'image']);
  });
});

describe('the context window and output cap the pin carries', () => {
  const endpoint = (provider: string, contextLength: number, maxCompletionTokens: number) => ({
    provider,
    uptime: 100,
    contextLength,
    maxCompletionTokens,
    tools: true,
  });

  it('pins the smallest routed window and caps output well below it', () => {
    expect(
      openRouterModelLimits(
        [
          endpoint('a', 1_048_576, 943_718),
          endpoint('b', 1_000_000, 384_000),
          endpoint('unrouted', 262_144, 131_072),
        ],
        ['a', 'b'],
      ),
    ).toEqual({ contextWindow: 1_000_000, maxTokens: OPENROUTER_MAX_OUTPUT_TOKENS });
  });

  it('lets no single small endpoint shrink every answer, but never asks more than any accepts', () => {
    expect(
      openRouterModelLimits([endpoint('a', 1_048_576, 2_048), endpoint('b', 1_048_576, 131_072)], [
        'a',
        'b',
      ]),
    ).toEqual({ contextWindow: 1_048_576, maxTokens: OPENROUTER_MAX_OUTPUT_TOKENS });
    expect(
      openRouterModelLimits([endpoint('a', 1_048_576, 4_096), endpoint('b', 1_048_576, 2_048)], [
        'a',
        'b',
      ]),
    ).toEqual({ contextWindow: 1_048_576, maxTokens: 4_096 });
    expect(openRouterModelLimits([endpoint('a', 0, 4_096)], ['a'])).toBeUndefined();
  });

  it('reads each endpoint output limit from the listing', () => {
    const parsed = parseOpenRouterEndpoints(OPENROUTER_GLM_5_3_FLASH_ENDPOINTS);
    expect(parsed.endpoints.find((entry) => entry.provider === 'morph')?.maxCompletionTokens).toBe(
      943_718,
    );
  });

  it('writes them on the model override, where pi applies them over its catalog', () => {
    const routing = {
      only: ['morph'],
      order: ['morph'],
      allow_fallbacks: true,
      require_parameters: false,
    };
    const composed = withOpenRouterModelRouting(
      {},
      { model: MODEL, routing, limits: { contextWindow: 1_048_576, maxTokens: 32_768 } },
    ) as any;
    expect(composed.providers.openrouter.modelOverrides[MODEL]).toEqual({
      compat: { openRouterRouting: routing },
      contextWindow: 1_048_576,
      maxTokens: 32_768,
    });
  });

  it('re-asks rather than trusting a cache entry written before the limits were recorded', async () => {
    const cacheDir = await scratch();
    const fetchImpl = fetchStub();
    const now = () => 1_000_000;
    writeFileSync(
      resolve(cacheDir, 'z-ai_glm-5.3-flash.json'),
      JSON.stringify({
        model: MODEL,
        fetchedAt: 1_000_000,
        providers: ['baseten'],
        bar: 98,
        input: ['text', 'image'],
      }),
    );
    const decision = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now });
    expect(decision.source).toBe('live');
    expect(decision.limits).toEqual({ contextWindow: 1_048_576, maxTokens: 32_768 });
  });

  it('carries them through the cache and a one-provider override', async () => {
    const cacheDir = await scratch();
    const fetchImpl = fetchStub();
    let clock = 1_000_000;
    const now = () => clock;
    await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now });
    clock += 1;
    const cached = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl, now });
    expect(cached.source).toBe('cache');
    expect(cached.limits).toEqual({ contextWindow: 1_048_576, maxTokens: 32_768 });
    const pinned = await resolveOpenRouterRouting({
      model: MODEL,
      cacheDir,
      fetchImpl,
      now,
      providerOverride: 'baseten',
    });
    expect(pinned.limits).toEqual({ contextWindow: 1_048_576, maxTokens: 32_768 });
  });
});

describe('openRouterRoutingInput', () => {
  it('names the model and cache dir only for an OpenRouter selection', () => {
    const config = { agentEnv: { OPENROUTER_API_KEY: 'k' }, openRouterRoutingCacheDir: '/cache' };
    expect(openRouterRoutingInput(config, { model: 'openrouter/z-ai/glm-5.3-flash' })).toEqual({
      openRouterRouting: { model: MODEL, cacheDir: '/cache', apiKey: 'k', historyRoomsDir: '/rooms' },
    });
    expect(openRouterRoutingInput(config, { model: 'claude-opus-4-1' })).toEqual({});
    expect(
      openRouterRoutingInput({ agentEnv: {} }, { model: 'openrouter/z-ai/glm-5.3-flash' }),
    ).toEqual({});
  });
});

/** The uptime pass, already decided, so a probe test never touches the listing. */
async function seedUptimeCache(cacheDir: string, providers: string[]): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    resolve(cacheDir, 'z-ai_glm-5.3-flash.json'),
    JSON.stringify({
      policy: 'cache-sticky-v1',
      model: MODEL,
      fetchedAt: Date.now(),
      providers,
      bar: 98,
      input: ['text', 'image'],
      limits: { contextWindow: 1_048_576, maxTokens: 32_768 },
    }),
  );
}

/**
 * One chat completion per provider, recorded live on 2026-09-04: `text: ''` is
 * the C92 failure — a 200 OK carrying nothing, which OpenRouter counts as
 * uptime. `delayMs` is real elapsed time, proving that latency cannot
 * reorder the next activation's candidates.
 */
function probeFetchStub(
  providers: Record<string, { text: string; delayMs?: number; status?: number }>,
): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const impl = async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { provider?: { only?: string[] } };
    const provider = body.provider?.only?.[0] ?? '';
    asked.push(provider);
    const entry = providers[provider];
    if (!entry) return jsonResponse({ error: { message: 'no endpoints' } }, 404);
    if (entry.delayMs) await new Promise((done) => setTimeout(done, entry.delayMs));
    if (entry.status && entry.status !== 200)
      return jsonResponse({ error: 'refused' }, entry.status);
    return jsonResponse({ choices: [{ message: { content: entry.text } }] });
  };
  return { fetchImpl: impl as unknown as typeof fetch, asked };
}

describe('the OpenRouter answer probe', () => {
  it('keeps the tool-enabled empty-completion test and bounded direct probe', async () => {
    const { fetchImpl, asked } = probeFetchStub({
      a: { text: '' }, b: { text: 'ready', delayMs: 5 }, c: { text: 'ready' },
    });
    const results = await probeOpenRouterProviders({ model: MODEL, providers: ['a', 'b', 'c'], apiKey: 'k', fetchImpl, maxCandidates: 2 });
    expect(asked.sort()).toEqual(['a', 'b']);
    expect(results.map((row) => row.answered)).toEqual([false, true]);
    expect(results[0]?.note).toBe('empty completion');
    expect(OPENROUTER_PROBE_CACHE_TTL_MS).toBe(OPENROUTER_ROUTING_CACHE_TTL_MS);
  });

  it('keeps the named override without buying another probe', async () => {
    const cacheDir = await scratch();
    await seedUptimeCache(cacheDir, ['morph', 'venice', 'phala']);
    const decision = await resolveOpenRouterRouting({ model: MODEL, cacheDir, apiKey: 'k',
      providerOverride: 'venice', fetchImpl: probeFetchStub({}).fetchImpl });
    expect(decision.routing).toEqual({ only: ['venice'], order: ['venice'], allow_fallbacks: false, require_parameters: false });
  });
});

describe('OpenRouter cache continuity', () => {
  const endpoint = (provider: string, uptime: number, pricing?: Record<string, unknown>) => ({
    tag: provider,
    uptime_last_30m: uptime,
    context_length: 1000,
    supported_parameters: ['tools'],
    pricing,
  });

  it('leaves normal provider order unset so pi session IDs enable native stickiness', () => {
    const routing = openRouterRoutingFor(['relace', 'wafer']);
    expect(routing).toEqual({
      only: ['relace', 'wafer'],
      allow_fallbacks: true,
      require_parameters: false,
    });
    // The empty-completion recovery override remains a strict named pin.
    expect(openRouterRoutingFor(['relace'], false)).toEqual({
      only: ['relace'], order: ['relace'], allow_fallbacks: false, require_parameters: false,
    });
  });

  it('prefers a discounted cache provider at 96% over cache-cold providers at 100%', () => {
    const parsed = parseOpenRouterEndpoints({ data: { endpoints: [
      endpoint('cold', 100),
      endpoint('equal-price', 100, { prompt: '0.1', input_cache_read: '0.1' }),
      endpoint('warm', 96, { prompt: '0.1', input_cache_read: '0.01' }),
      endpoint('down', 94, { prompt: '0.1', input_cache_read: '0.01' }),
    ] } });
    expect(selectReliableOpenRouterProviders(parsed.endpoints, 1000).providers).toEqual(['warm']);
  });

  it('accepts free cache reads but rejects absent, invalid, and undiscounted prices', () => {
    const parsed = parseOpenRouterEndpoints({ data: { endpoints: [
      endpoint('warm', 100, { prompt: '0.1', input_cache_read: '0' }),
      ...[undefined, null, '', 'bad', '-1', 'Infinity', '0.2'].map((price, i) =>
        endpoint(`invalid-${i}`, 100, { prompt: '0.1', input_cache_read: price })),
    ] } });
    expect(selectReliableOpenRouterProviders(parsed.endpoints, 1000).providers).toEqual(['warm']);
  });

  it('retains the reliability fallback for models with no published cache discounts', () => {
    const parsed = parseOpenRouterEndpoints({ data: { endpoints: [
      endpoint('a', 100), endpoint('b', 99),
      endpoint('invalid', 90, { prompt: '0.1', input_cache_read: '0.01' }),
    ] } });
    expect(selectReliableOpenRouterProviders(parsed.endpoints, 1000).providers).toEqual(['a', 'b']);
  });

  it('keeps the probe candidate pool stable when uptime rankings change at refresh', async () => {
    const cacheDir = await scratch();
    const pricing = { prompt: '0.1', input_cache_read: '0.01' };
    let clock = 0;
    const now = () => clock;
    await resolveOpenRouterRouting({ model: MODEL, cacheDir, now, fetchImpl: fetchStub({
      data: { endpoints: [endpoint('warm', 100, pricing), endpoint('other', 99, pricing)] },
    }) });
    clock += OPENROUTER_ROUTING_CACHE_TTL_MS;
    const refreshed = await resolveOpenRouterRouting({ model: MODEL, cacheDir, now,
      fetchImpl: fetchStub({ data: { endpoints: [
        endpoint('other', 100, pricing), endpoint('warm', 97, pricing),
        endpoint('new', 100, pricing),
      ] } }),
    });
    expect(refreshed.providers).toEqual(['warm', 'other', 'new']);
    expect(refreshed.bar).toBe(95);
    expect(refreshed.routing).not.toHaveProperty('order');
  });

  it('re-fetches a fresh pre-stickiness cache so cache-cold providers are not kept for 24h', async () => {
    const cacheDir = await scratch();
    await seedUptimeCache(cacheDir, ['cold', 'warm']);
    const cachedPath = resolve(cacheDir, 'z-ai_glm-5.3-flash.json');
    const old = JSON.parse(readFileSync(cachedPath, 'utf8'));
    delete old.policy;
    writeFileSync(cachedPath, JSON.stringify(old));
    const fetchImpl = fetchStub({ data: { endpoints: [
      endpoint('cold', 100), endpoint('warm', 100, { prompt: '0.1', input_cache_read: '0.01' }),
    ] } });
    const decision = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl });
    expect(decision.source).toBe('live');
    expect(decision.providers).toEqual(['warm']);
    expect(decision.routing).not.toHaveProperty('order');
  });
});


describe('daily effective-cost routing', () => {
  const endpoint = (provider: string, price: number, cachePrice: number) => ({
    tag: provider, provider_name: provider, context_length: 1000,
    uptime_last_30m: 100, supported_parameters: ['tools'],
    pricing: { prompt: price, input_cache_read: cachePrice },
  });
  const traffic = (provider: string, cacheShare: number) => ({
    provider, cacheShare, calls: 10, promptTokens: 1000, cachedTokens: 1000 * cacheShare,
  });

  it('drops Wafer from the cheapest three using measured cache share despite its published discount', () => {
    const { endpoints } = parseOpenRouterEndpoints({ data: { endpoints: [
      endpoint('Wafer', .08, .034), endpoint('Relace', .05, .008),
      endpoint('Baidu', .0333, .000666), endpoint('DigitalOcean', .165, .006),
    ] } });
    const ranked = rankOpenRouterProviders(endpoints, 1000, [
      traffic('Wafer', .57), traffic('Relace', .936), traffic('Baidu', .897), traffic('DigitalOcean', .967),
    ], ['Wafer', 'Relace', 'Baidu', 'DigitalOcean']);
    expect(ranked.slice(0, 3).map((row) => row.provider)).toEqual(['Baidu', 'Relace', 'DigitalOcean']);
    expect(ranked[3]?.effectiveInputPrice).toBeCloseTo(.05378);
  });

  it('uses the median measured provider cache share for unseen providers', () => {
    const { endpoints } = parseOpenRouterEndpoints({ data: { endpoints: [endpoint('unseen', 1, .1)] } });
    const [ranked] = rankOpenRouterProviders(endpoints, 1000,
      [traffic('a', .2), traffic('b', .8)], ['unseen']);
    expect(ranked).toMatchObject({ cacheShare: .5, measuredCalls: 0, effectiveInputPrice: .55 });
  });

  it('requires tools, full context, 95% uptime and a nonempty answer, and never ranks by latency', () => {
    const base = endpoint('eligible', 1, .1);
    const { endpoints } = parseOpenRouterEndpoints({ data: { endpoints: [
      base, { ...base, tag: 'silent' }, { ...base, tag: 'no-tools', supported_parameters: [] },
      { ...base, tag: 'short', context_length: 999 }, { ...base, tag: 'down', uptime_last_30m: 94.99 },
      { ...base, tag: 'relaxed', uptime_last_30m: 95, pricing: { prompt: .5, input_cache_read: .05 } },
    ] } });
    expect(rankOpenRouterProviders(endpoints, 1000, [], ['eligible', 'no-tools', 'short', 'down', 'relaxed'])
      .map((row) => row.provider)).toEqual(['relaxed', 'eligible']);
  });

  function dailyFetch() {
    const listing = { data: { context_length: 1000, architecture: { input_modalities: ['text'] }, endpoints: [
      endpoint('expensive', .08, .034), endpoint('cheap', .0333, .000666),
      endpoint('middle', .05, .008), endpoint('silent', .001, .0001),
    ] } };
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const address = String(url); requests.push(address);
      if (address.endsWith('/endpoints')) return jsonResponse(listing);
      const body = JSON.parse(String(init?.body));
      expect(body.provider.allow_fallbacks).toBe(false);
      expect(body.tools).toHaveLength(1);
      const provider = body.provider.only[0];
      return jsonResponse({ choices: [{ message: { content: provider === 'silent' ? '' : 'ready' } }] });
    }) as unknown as typeof fetch;
    return { fetchImpl, requests };
  }

  it('qualifies once, keeps the top-three set fixed all day and refreshes only for new activations', async () => {
    const cacheDir = await scratch(); let clock = 1_000_000;
    const { fetchImpl, requests } = dailyFetch();
    const input = { model: MODEL, cacheDir, apiKey: 'k', fetchImpl, now: () => clock };
    const initial = await resolveOpenRouterRouting(input);
    expect(initial.providers).toEqual(['cheap', 'middle', 'expensive']);
    expect(initial.routing).not.toHaveProperty('order');
    expect(initial.routing.allow_fallbacks).toBe(true);
    const count = requests.length;
    clock += 6 * 60 * 60 * 1000;
    const later = await resolveOpenRouterRouting(input);
    expect(later.providers).toEqual(initial.providers);
    expect(later.refresh).toBeUndefined(); expect(requests).toHaveLength(count);
    clock += OPENROUTER_ROUTING_CACHE_TTL_MS;
    const stale = await resolveOpenRouterRouting(input);
    expect(stale.providers).toEqual(initial.providers);
    expect(stale.refresh).toBeDefined();
    await stale.refresh;
    expect(requests.length).toBeGreaterThan(count);
    const updated = await resolveOpenRouterRouting(input);
    expect(updated.source).toBe('cache'); expect(updated.refresh).toBeUndefined();
  });

  it('uses real generation-cache shares when building the daily set and keeps them fixed between rebuilds', async () => {
    const cacheDir = await scratch(); const now = () => 1_000_000;
    const path = resolve(cacheDir, 'z-ai_glm-5.3-flash.generations.json');
    const observations = [
      { id: 'middle', timestamp: now(), provider: 'middle', promptTokens: 100, cachedTokens: 99 },
      { id: 'cheap', timestamp: now(), provider: 'cheap', promptTokens: 100, cachedTokens: 0 },
      { id: 'expensive', timestamp: now(), provider: 'expensive', promptTokens: 100, cachedTokens: 0 },
    ];
    await writeFile(path, JSON.stringify({ model: MODEL, observations }));
    const { fetchImpl, requests } = dailyFetch();
    const input = { model: MODEL, cacheDir, apiKey: 'k', fetchImpl, now };
    const initial = await resolveOpenRouterRouting(input);
    expect(initial.providers).toEqual(['middle', 'cheap', 'expensive']);
    const count = requests.length;
    await writeFile(path, JSON.stringify({ model: MODEL, observations: observations.map((row) => ({ ...row, cachedTokens: 0 })) }));
    expect((await resolveOpenRouterRouting(input)).providers).toEqual(initial.providers);
    expect(requests).toHaveLength(count);
    const pin = withOpenRouterModelRouting({}, { model: MODEL, routing: initial.routing }) as any;
    expect(pin.providers.openrouter.modelOverrides[MODEL].compat.openRouterRouting).toEqual({
      only: ['middle', 'cheap', 'expensive'], allow_fallbacks: true, require_parameters: false,
    });
  });

  it('coalesces parallel cold activations and does not retry a failed daily build per call', async () => {
    const cacheDir = await scratch();
    const { fetchImpl, requests } = dailyFetch();
    const input = { model: MODEL, cacheDir, apiKey: 'k', fetchImpl };
    const results = await Promise.all([resolveOpenRouterRouting(input), resolveOpenRouterRouting(input)]);
    expect(results[0].providers).toEqual(results[1].providers);
    expect(requests.filter((url) => url.endsWith('/endpoints'))).toHaveLength(1);
    const failedDir = await scratch();
    const down = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await resolveOpenRouterRouting({ ...input, cacheDir: failedDir, fetchImpl: down });
    const count = (down as any).mock.calls.length;
    await resolveOpenRouterRouting({ ...input, cacheDir: failedDir, fetchImpl: down });
    expect((down as any).mock.calls).toHaveLength(count);
  });
});
