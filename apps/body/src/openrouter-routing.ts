/**
 * Per-model OpenRouter provider pinning derived from live data.
 *
 * #840 pinned EVERY OpenRouter model to one hard-coded pair
 * (`deepinfra`/`novita`, no fallbacks). That is right for `z-ai/glm-5.3-flash`
 * and wrong for any model those two do not serve ("no endpoints"), and a pair
 * has no headroom when one provider degrades. This module instead asks
 * OpenRouter's public endpoints listing (`/api/v1/models/<model>/endpoints`,
 * no key needed) which providers currently serve the model reliably:
 *
 *   keep   uptime_last_30m >= 98 AND `tools` in supported_parameters AND
 *          context_length >= the model's advertised context
 *   order  uptime desc
 *   only   that set; when fewer than 2 qualify the bar drops to 95 (logged);
 *          when none qualify at all, #840's pair remains the last resort
 *   allow_fallbacks: true WITHIN the set, require_parameters: true
 *
 * The result is cached per model for 24h (`<cacheDir>/<model>.json`), read
 * back when the API is unreachable (stale is better than blind), and applied
 * to that one model's entry in the agent's pi `models.json` — never globally.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const OPENROUTER_ENDPOINTS_BASE_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_ROUTING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const OPENROUTER_ROUTING_FETCH_TIMEOUT_MS = 10_000;
export const OPENROUTER_UPTIME_BAR = 98;
export const OPENROUTER_UPTIME_BAR_RELAXED = 95;
export const OPENROUTER_MIN_PROVIDERS = 2;

/** #840's hand-picked pair: the last resort when nothing live or cached exists. */
export const OPENROUTER_FALLBACK_PROVIDERS = ['deepinfra', 'novita'] as const;

export interface OpenRouterRouting {
  only: string[];
  order: string[];
  allow_fallbacks: boolean;
  require_parameters: boolean;
}

export interface OpenRouterEndpoint {
  /** Provider slug OpenRouter accepts in `provider.only`/`order` (`tag` before any `/`). */
  provider: string;
  uptime: number;
  contextLength: number;
  tools: boolean;
}

export interface OpenRouterProviderSelection {
  providers: string[];
  /** The uptime bar the set was chosen at, or `null` when nothing qualified. */
  bar: number | null;
  contextLength: number | undefined;
}

export type OpenRouterRoutingSource = 'live' | 'cache' | 'stale-cache' | 'fallback';

export interface OpenRouterRoutingDecision {
  model: string;
  routing: OpenRouterRouting;
  providers: string[];
  bar: number | null;
  source: OpenRouterRoutingSource;
  /** The one daemon log line describing this decision. */
  line: string;
}

interface CachedRouting {
  model: string;
  fetchedAt: number;
  providers: string[];
  bar: number | null;
}

/**
 * The OpenRouter model id behind a catalog selection: `openrouter/<id>` from
 * pi's namespaced catalog, or a bare `<vendor>/<model>` id when the runtime's
 * only provider credential is an OpenRouter key (the connect wizard stores the
 * bare id). Anything else is not an OpenRouter model.
 */
export function openRouterModelId(
  model: string | undefined,
  env: Record<string, string | undefined> = {},
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('openrouter/')) {
    const id = trimmed.slice('openrouter/'.length);
    return id.includes('/') ? id : undefined;
  }
  if (env.OPENROUTER_API_KEY?.trim() && /^[^/\s]+\/[^/\s][^\s]*$/.test(trimmed)) return trimmed;
  return undefined;
}

/** Reduce the public endpoints payload to the four facts the selection needs. */
export function parseOpenRouterEndpoints(payload: unknown): {
  endpoints: OpenRouterEndpoint[];
  contextLength: number | undefined;
} {
  const data = (payload as { data?: unknown } | undefined)?.data;
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const raw = Array.isArray(record.endpoints) ? record.endpoints : [];
  const endpoints: OpenRouterEndpoint[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const endpoint = entry as Record<string, unknown>;
    const tag = typeof endpoint.tag === 'string' ? endpoint.tag : '';
    const provider = tag.split('/')[0]?.trim() ?? '';
    if (!provider) continue;
    const uptime = typeof endpoint.uptime_last_30m === 'number' ? endpoint.uptime_last_30m : 0;
    const contextLength = typeof endpoint.context_length === 'number' ? endpoint.context_length : 0;
    const supported = Array.isArray(endpoint.supported_parameters)
      ? endpoint.supported_parameters
      : [];
    endpoints.push({ provider, uptime, contextLength, tools: supported.includes('tools') });
  }
  return {
    endpoints,
    contextLength:
      typeof record.context_length === 'number'
        ? record.context_length
        : advertisedContextLength(endpoints),
  };
}

/**
 * The listing carries no top-level context for the model, so the advertised
 * default is the context most tool-capable endpoints agree on (ties resolve
 * to the larger window). A provider serving a truncated window is excluded.
 */
function advertisedContextLength(endpoints: OpenRouterEndpoint[]): number | undefined {
  const counts = new Map<number, number>();
  for (const endpoint of endpoints) {
    if (!endpoint.tools || endpoint.contextLength <= 0) continue;
    counts.set(endpoint.contextLength, (counts.get(endpoint.contextLength) ?? 0) + 1);
  }
  let best: number | undefined;
  for (const [length, count] of counts) {
    if (best === undefined) {
      best = length;
      continue;
    }
    const bestCount = counts.get(best) ?? 0;
    if (count > bestCount || (count === bestCount && length > best)) best = length;
  }
  return best;
}

/** Apply the reliability rule to parsed endpoints. */
export function selectReliableOpenRouterProviders(
  endpoints: OpenRouterEndpoint[],
  contextLength: number | undefined,
): OpenRouterProviderSelection {
  const eligible = endpoints.filter(
    (endpoint) =>
      endpoint.tools && (contextLength === undefined || endpoint.contextLength >= contextLength),
  );
  const atBar = (bar: number): string[] => {
    const seen = new Set<string>();
    return eligible
      .filter((endpoint) => endpoint.uptime >= bar)
      .sort((left, right) => right.uptime - left.uptime)
      .map((endpoint) => endpoint.provider)
      .filter((provider) => (seen.has(provider) ? false : (seen.add(provider), true)));
  };
  const strict = atBar(OPENROUTER_UPTIME_BAR);
  if (strict.length >= OPENROUTER_MIN_PROVIDERS) {
    return { providers: strict, bar: OPENROUTER_UPTIME_BAR, contextLength };
  }
  const relaxed = atBar(OPENROUTER_UPTIME_BAR_RELAXED);
  if (relaxed.length > 0) {
    return { providers: relaxed, bar: OPENROUTER_UPTIME_BAR_RELAXED, contextLength };
  }
  return { providers: [], bar: null, contextLength };
}

export function openRouterRoutingFor(providers: readonly string[]): OpenRouterRouting {
  return {
    only: [...providers],
    order: [...providers],
    allow_fallbacks: true,
    require_parameters: true,
  };
}

/** Where a daemon keeps its per-model routing decisions: `<runtimeDir>/openrouter-routing/`. */
export function openRouterRoutingCacheDir(runtimeDir: string): string {
  return resolve(runtimeDir, 'openrouter-routing');
}

function cachePath(cacheDir: string, model: string): string {
  return resolve(cacheDir, `${model.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`);
}

async function readCache(cacheDir: string, model: string): Promise<CachedRouting | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(cacheDir, model), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const cached = parsed as Partial<CachedRouting>;
    if (
      cached.model !== model ||
      typeof cached.fetchedAt !== 'number' ||
      !Array.isArray(cached.providers) ||
      !cached.providers.every((provider) => typeof provider === 'string' && provider.length > 0)
    ) {
      return undefined;
    }
    return {
      model,
      fetchedAt: cached.fetchedAt,
      providers: cached.providers,
      bar: typeof cached.bar === 'number' ? cached.bar : null,
    };
  } catch {
    return undefined;
  }
}

async function writeCache(cacheDir: string, value: CachedRouting): Promise<void> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await writeFile(cachePath(cacheDir, value.model), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

function decision(
  model: string,
  providers: readonly string[],
  bar: number | null,
  source: OpenRouterRoutingSource,
  note?: string,
): OpenRouterRoutingDecision {
  const criteria = bar === null ? 'fallback pair' : `uptime ≥${bar}%, tools`;
  const suffix = [
    bar === OPENROUTER_UPTIME_BAR_RELAXED ? 'bar lowered: fewer than 2 providers at 98%' : '',
    source === 'cache' ? 'cached' : '',
    source === 'stale-cache' ? 'stale cache' : '',
    note ?? '',
  ]
    .filter(Boolean)
    .join('; ');
  return {
    model,
    routing: openRouterRoutingFor(providers),
    providers: [...providers],
    bar,
    source,
    line:
      `[body] openrouter routing for ${model}: ${providers.join(', ')} (${criteria}` +
      (suffix ? `; ${suffix})` : ')'),
  };
}

export interface ResolveOpenRouterRoutingInput {
  model: string;
  cacheDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * The fallback ladder: fresh cache → live API (cached on success) → any
 * cached set, however old → #840's pair. Never throws; the decision's `line`
 * is the one log line a caller prints.
 */
export async function resolveOpenRouterRouting(
  input: ResolveOpenRouterRoutingInput,
): Promise<OpenRouterRoutingDecision> {
  const now = input.now ?? Date.now;
  const cached = await readCache(input.cacheDir, input.model);
  if (cached && now() - cached.fetchedAt < OPENROUTER_ROUTING_CACHE_TTL_MS) {
    return decision(input.model, cached.providers, cached.bar, 'cache');
  }
  let failure: string;
  try {
    const doFetch = input.fetchImpl ?? fetch;
    const response = await doFetch(`${OPENROUTER_ENDPOINTS_BASE_URL}/${input.model}/endpoints`, {
      signal: AbortSignal.timeout(input.timeoutMs ?? OPENROUTER_ROUTING_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { endpoints, contextLength } = parseOpenRouterEndpoints(await response.json());
    if (endpoints.length === 0) throw new Error('no endpoints listed');
    const selected = selectReliableOpenRouterProviders(endpoints, contextLength);
    if (selected.providers.length === 0) {
      // Live data says nobody serves this model reliably right now; do not
      // cache that verdict, the next activation should ask again.
      return decision(
        input.model,
        OPENROUTER_FALLBACK_PROVIDERS,
        null,
        'fallback',
        'no provider met the bar',
      );
    }
    await writeCache(input.cacheDir, {
      model: input.model,
      fetchedAt: now(),
      providers: selected.providers,
      bar: selected.bar,
    }).catch(() => undefined);
    return decision(input.model, selected.providers, selected.bar, 'live');
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (cached) {
    return decision(
      input.model,
      cached.providers,
      cached.bar,
      'stale-cache',
      `api unreachable: ${failure}`,
    );
  }
  return decision(
    input.model,
    OPENROUTER_FALLBACK_PROVIDERS,
    null,
    'fallback',
    `api unreachable: ${failure}`,
  );
}

/**
 * Pin ONE model inside pi's `models.json` without touching operator custom
 * providers or any other model: the routing lands on
 * `providers.openrouter.modelOverrides[<model>].compat.openRouterRouting`,
 * pi's topmost per-model layer. With no model to pin, the object form still
 * gains an empty `providers` map (pi's schema requires the key).
 */
export function withOpenRouterModelRouting(
  value: unknown,
  pin: { model: string; routing: OpenRouterRouting } | undefined,
): Record<string, unknown> {
  const root =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  const applyOverride = (provider: Record<string, unknown>): Record<string, unknown> => {
    if (!pin) return provider;
    const overrides =
      provider.modelOverrides &&
      typeof provider.modelOverrides === 'object' &&
      !Array.isArray(provider.modelOverrides)
        ? { ...(provider.modelOverrides as Record<string, unknown>) }
        : {};
    const existing = overrides[pin.model];
    const override =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    const compat =
      override.compat && typeof override.compat === 'object' && !Array.isArray(override.compat)
        ? { ...(override.compat as Record<string, unknown>) }
        : {};
    override.compat = { ...compat, openRouterRouting: pin.routing };
    overrides[pin.model] = override;
    return { ...provider, modelOverrides: overrides };
  };
  if (Array.isArray(root.providers)) {
    if (!pin) return root;
    const providers = root.providers.map((provider) =>
      provider && typeof provider === 'object'
        ? { ...(provider as Record<string, unknown>) }
        : provider,
    );
    const index = providers.findIndex(
      (provider) => provider && typeof provider === 'object' && provider.name === 'openrouter',
    );
    const current = applyOverride(
      index >= 0 ? (providers[index] as Record<string, unknown>) : { name: 'openrouter' },
    );
    if (index >= 0) providers[index] = current;
    else providers.push(current);
    root.providers = providers;
    return root;
  }
  const providers =
    root.providers && typeof root.providers === 'object'
      ? { ...(root.providers as Record<string, unknown>) }
      : {};
  if (pin) {
    const current =
      providers.openrouter &&
      typeof providers.openrouter === 'object' &&
      !Array.isArray(providers.openrouter)
        ? { ...(providers.openrouter as Record<string, unknown>) }
        : {};
    providers.openrouter = applyOverride(current);
  }
  root.providers = providers;
  return root;
}

/**
 * The `prepareRoomAgentHome` input for one activation: present only when the
 * effective selection names an OpenRouter model and the daemon has a cache
 * directory; otherwise nothing is pinned.
 */
export function openRouterRoutingInput(
  config: { agentEnv: Record<string, string>; openRouterRoutingCacheDir?: string },
  selection: { model?: string } | undefined,
  fetchImpl?: typeof fetch,
): { openRouterRouting?: ResolveOpenRouterRoutingInput } {
  const model = openRouterModelId(selection?.model, config.agentEnv);
  if (!model || !config.openRouterRoutingCacheDir) return {};
  return {
    openRouterRouting: {
      model,
      cacheDir: config.openRouterRoutingCacheDir,
      ...(fetchImpl ? { fetchImpl } : {}),
    },
  };
}
