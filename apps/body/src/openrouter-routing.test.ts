import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { OPENROUTER_GLM_5_3_FLASH_ENDPOINTS } from './fixtures/openrouter-endpoints-glm-5.3-flash.js';
import {
  OPENROUTER_FALLBACK_PROVIDERS,
  OPENROUTER_PROBE_CACHE_TTL_MS,
  OPENROUTER_ROUTING_CACHE_TTL_MS,
  openRouterModelId,
  openRouterRoutingInput,
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
    // C87: the listing's own input modalities ride with the pin.
    expect(decision.input).toEqual(['text', 'image']);
    const cached = JSON.parse(readFileSync(resolve(cacheDir, 'z-ai_glm-5.3-flash.json'), 'utf8'));
    expect(cached).toEqual({
      model: MODEL,
      fetchedAt: 1_000_000,
      providers: EXPECTED_PROVIDERS,
      bar: 98,
      input: ['text', 'image'],
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

describe('openRouterRoutingInput', () => {
  it('names the model and cache dir only for an OpenRouter selection', () => {
    const config = { agentEnv: { OPENROUTER_API_KEY: 'k' }, openRouterRoutingCacheDir: '/cache' };
    expect(openRouterRoutingInput(config, { model: 'openrouter/z-ai/glm-5.3-flash' })).toEqual({
      openRouterRouting: { model: MODEL, cacheDir: '/cache', apiKey: 'k' },
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
      model: MODEL,
      fetchedAt: Date.now(),
      providers,
      bar: 98,
      input: ['text', 'image'],
    }),
  );
}

/**
 * One chat completion per provider, recorded live on 2026-09-04: `text: ''` is
 * the C92 failure — a 200 OK carrying nothing, which OpenRouter counts as
 * uptime. `delayMs` is real elapsed time, so the latency ordering the pin
 * derives is measured here exactly as it is in production.
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
  it('drops a provider that returns an empty completion and orders the rest by latency', async () => {
    const cacheDir = await scratch();
    await seedUptimeCache(cacheDir, ['morph', 'venice', 'phala']);
    const { fetchImpl, asked } = probeFetchStub({
      morph: { text: '' },
      venice: { text: 'ready', delayMs: 40 },
      phala: { text: 'ready', delayMs: 5 },
    });

    const decision = await resolveOpenRouterRouting({
      model: MODEL,
      cacheDir,
      apiKey: 'k',
      fetchImpl,
    });
    const probed = await decision.refresh;

    expect(asked.sort()).toEqual(['morph', 'phala', 'venice']);
    expect(probed?.providers).toEqual(['phala', 'venice']);
    expect(probed?.routing).toEqual({
      only: ['phala', 'venice'],
      order: ['phala', 'venice'],
      allow_fallbacks: true,
      require_parameters: false,
    });
    expect(probed?.line).toContain('answer-probed, fastest first');
    expect(probed?.line).toContain('dropped morph (empty completion)');
    const cached = JSON.parse(
      readFileSync(resolve(cacheDir, 'z-ai_glm-5.3-flash.probe.json'), 'utf8'),
    ) as { answered: { provider: string }[] };
    expect(cached.answered.map((entry) => entry.provider)).toEqual(['phala', 'venice']);
  });

  it('never blocks a turn on a cold probe cache: the uptime order is served now', async () => {
    const cacheDir = await scratch();
    await seedUptimeCache(cacheDir, ['morph', 'venice', 'phala']);
    const { fetchImpl } = probeFetchStub({
      morph: { text: '' },
      venice: { text: 'ready', delayMs: 40 },
      phala: { text: 'ready', delayMs: 5 },
    });

    const decision = await resolveOpenRouterRouting({
      model: MODEL,
      cacheDir,
      apiKey: 'k',
      fetchImpl,
    });

    // The decision the activation applies is the uptime order, in hand before
    // a single provider has been asked; the probe lands for the next one.
    expect(decision.providers).toEqual(['morph', 'venice', 'phala']);
    expect(decision.refresh).toBeDefined();
    expect(existsSync(resolve(cacheDir, 'z-ai_glm-5.3-flash.probe.json'))).toBe(false);
    await decision.refresh;
  });

  it('serves a fresh probe cache without asking anyone, and never resurrects a dropped provider', async () => {
    const cacheDir = await scratch();
    await seedUptimeCache(cacheDir, ['morph', 'venice', 'phala']);
    await writeFile(
      resolve(cacheDir, 'z-ai_glm-5.3-flash.probe.json'),
      JSON.stringify({
        model: MODEL,
        fetchedAt: Date.now(),
        // `fireworks` no longer clears the uptime/tools pass; a cached answer
        // must not put it back in the pin.
        answered: [
          { provider: 'phala', latencyMs: 5 },
          { provider: 'fireworks', latencyMs: 6 },
          { provider: 'venice', latencyMs: 40 },
        ],
      }),
    );
    const { fetchImpl, asked } = probeFetchStub({});

    const decision = await resolveOpenRouterRouting({
      model: MODEL,
      cacheDir,
      apiKey: 'k',
      fetchImpl,
    });

    expect(asked).toEqual([]);
    expect(decision.refresh).toBeUndefined();
    expect(decision.providers).toEqual(['phala', 'venice']);
    expect(decision.line).toContain('answer-probed, cached');
  });

  it('refreshes rather than trusting a probe older than its TTL', async () => {
    const cacheDir = await scratch();
    await seedUptimeCache(cacheDir, ['morph', 'venice']);
    await writeFile(
      resolve(cacheDir, 'z-ai_glm-5.3-flash.probe.json'),
      JSON.stringify({
        model: MODEL,
        fetchedAt: Date.now() - OPENROUTER_PROBE_CACHE_TTL_MS - 1,
        answered: [{ provider: 'morph', latencyMs: 2 }],
      }),
    );
    const { fetchImpl, asked } = probeFetchStub({
      morph: { text: '' },
      venice: { text: 'ready' },
    });

    const decision = await resolveOpenRouterRouting({
      model: MODEL,
      cacheDir,
      apiKey: 'k',
      fetchImpl,
    });
    const probed = await decision.refresh;

    expect(asked.sort()).toEqual(['morph', 'venice']);
    expect(probed?.providers).toEqual(['venice']);
  });

  it('keeps the uptime order and caches nothing when no provider answers', async () => {
    const cacheDir = await scratch();
    await seedUptimeCache(cacheDir, ['morph', 'venice']);
    const { fetchImpl } = probeFetchStub({
      morph: { text: '' },
      venice: { text: '', status: 429 },
    });

    const decision = await resolveOpenRouterRouting({
      model: MODEL,
      cacheDir,
      apiKey: 'k',
      fetchImpl,
    });

    expect(await decision.refresh).toBeUndefined();
    expect(decision.providers).toEqual(['morph', 'venice']);
    expect(existsSync(resolve(cacheDir, 'z-ai_glm-5.3-flash.probe.json'))).toBe(false);
  });

  it('runs no probe at all without an OpenRouter key', async () => {
    const cacheDir = await scratch();
    await seedUptimeCache(cacheDir, ['morph', 'venice']);
    const { fetchImpl, asked } = probeFetchStub({ morph: { text: 'ready' } });

    const decision = await resolveOpenRouterRouting({ model: MODEL, cacheDir, fetchImpl });

    expect(asked).toEqual([]);
    expect(decision.refresh).toBeUndefined();
    expect(decision.providers).toEqual(['morph', 'venice']);
  });

  it('asks at most the bounded number of candidates', async () => {
    const { fetchImpl, asked } = probeFetchStub({
      a: { text: 'ready' },
      b: { text: 'ready' },
      c: { text: 'ready' },
    });
    const results = await probeOpenRouterProviders({
      model: MODEL,
      providers: ['a', 'b', 'c'],
      apiKey: 'k',
      fetchImpl,
      maxCandidates: 2,
    });
    expect(asked.sort()).toEqual(['a', 'b']);
    expect(results.map((result) => result.answered)).toEqual([true, true]);
  });

  it('pins exactly one provider with no fallbacks when a turn re-pins after an empty completion', async () => {
    const cacheDir = await scratch();
    await seedUptimeCache(cacheDir, ['morph', 'venice', 'phala']);
    const { fetchImpl, asked } = probeFetchStub({});

    const decision = await resolveOpenRouterRouting({
      model: MODEL,
      cacheDir,
      apiKey: 'k',
      fetchImpl,
      providerOverride: 'venice',
    });

    expect(asked).toEqual([]);
    expect(decision.routing).toEqual({
      only: ['venice'],
      order: ['venice'],
      allow_fallbacks: false,
      require_parameters: false,
    });
    expect(decision.line).toContain('pinned to one provider after an empty completion');
  });
});
