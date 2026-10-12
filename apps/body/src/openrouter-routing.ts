/**
 * Per-model OpenRouter provider selection, fixed for a day.
 *
 * The public endpoints listing supplies tools, full context, 30-minute uptime
 * (at least 95%), and prompt/cache-read prices. Each eligible provider must
 * answer the existing small tool-enabled text probe. Among survivors, keep
 * the three cheapest effective input prices:
 *   prompt price × uncached share + cache-read price × cached share.
 * Shares come from this agent's own last-seven-day generation records;
 * providers with no observations use the median measured provider share.
 * With no measured shares yet, assume a cold prompt. Latency never reorders
 * or replaces the set, and no manual `provider.order` is sent: pi's stable
 * session id lets OpenRouter retain its cache provider and fail over inside
 * `only` on a real request failure.
 *
 * The qualified set and generation facts are cached privately per model.
 * A cold activation waits for qualification once; an expired daily set is
 * served immediately while its replacement is built in the background for
 * the next activation. Live sessions are never changed by a refresh. Missing
 * API credentials or a failed refresh retain the existing reliability/stale
 * fallback; an empty-completion retry still explicitly pins one provider.
 *
 * The SAME listing also names the model's real input modalities
 * (`architecture.input_modalities`), and that fact has to be pinned beside the
 * providers (C87). A pi `models.json` custom-model entry — every Beeline
 * OpenRouter agent has one, because the key is fronted by an egress proxy —
 * REPLACES pi's built-in catalog record for that id, and pi defaults a
 * definition without `input` to `["text"]`. pi then rewrites every image block
 * in the prompt to the literal text `(image omitted: model does not support
 * images)` before the request leaves the process, so a photo never reaches a
 * vision-capable model. `modelOverrides[<model>].input` is applied last, over
 * both layers, so the live modalities are pinned there.
 *
 * The listing's context and output limits are pinned there too. pi otherwise
 * takes them from its bundled catalog, which can promise a far larger output
 * than the routed endpoints leave room for (DeepSeek V4: a 1,048,576-token
 * window and up to the whole window as output). pi then asks for
 * `max_tokens = window - estimated input - 4096`, its chars/4 estimate
 * undershoots dense code, and OpenRouter refuses the request with 400 "This
 * endpoint's maximum context length is 1048576 tokens". The pin sets
 * `contextWindow` to the smallest window among the routed providers and caps
 * `maxTokens` at `OPENROUTER_MAX_OUTPUT_TOKENS` (lower only when no routed
 * endpoint accepts that much output). A model the listing names no endpoints
 * for (a `~vendor/model-latest` router alias) still gets the output cap.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readOpenRouterTraffic, type OpenRouterProviderTraffic } from './openrouter-history.js';
import { writePrivateFileAtomically } from './atomic-private-file.js';

export const OPENROUTER_ENDPOINTS_BASE_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_ROUTING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const OPENROUTER_ROUTING_FETCH_TIMEOUT_MS = 10_000;
/** The answer probe is a live purchase; keep it short-lived but not per-turn. */
export const OPENROUTER_PROBE_CACHE_TTL_MS = OPENROUTER_ROUTING_CACHE_TTL_MS;
/** Default bound for the direct probe helper; daily qualification checks all eligible providers. */
export const OPENROUTER_PROBE_MAX_CANDIDATES = 6;
export const OPENROUTER_PROBE_TIMEOUT_MS = 20_000;
export const OPENROUTER_UPTIME_BAR = 98;
export const OPENROUTER_UPTIME_BAR_RELAXED = 95;
export const OPENROUTER_MIN_PROVIDERS = 2;
/** Re-read old uptime-only selections once to learn their cache pricing. */
const ROUTING_POLICY = 'cache-sticky-v1';
/** Output ceiling pinned on an OpenRouter model; leaves the window to the input. */
export const OPENROUTER_MAX_OUTPUT_TOKENS = 32_768;

/** #840's hand-picked pair: the last resort when nothing live or cached exists. */
export const OPENROUTER_FALLBACK_PROVIDERS = ['deepinfra', 'novita'] as const;

export interface OpenRouterRouting {
  only: string[];
  /** Only a failure recovery pin supplies an order; normal routing stays sticky. */
  order?: string[];
  allow_fallbacks: boolean;
  require_parameters: boolean;
}

export interface OpenRouterEndpoint {
  /** Provider slug OpenRouter accepts in `provider.only`/`order` (`tag` before any `/`). */
  provider: string;
  uptime: number;
  contextLength: number;
  /** The endpoint's own output ceiling; 0 when the listing names none. */
  maxCompletionTokens: number;
  tools: boolean;
  /** Published cache reads cost less than ordinary prompt tokens. */
  discountedCacheRead?: boolean;
  providerName?: string;
  promptPrice?: number;
  cacheReadPrice?: number;
}

/** The window and output ceiling pinned on the model (`modelOverrides`). */
export interface OpenRouterModelLimits {
  contextWindow: number;
  maxTokens: number;
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
  /**
   * The model's input modalities in pi's vocabulary, pinned beside the
   * providers so a custom-model entry cannot silently downgrade a
   * vision-capable model to text (C87). `undefined` when the listing did not
   * name them — the pin then leaves `input` alone.
   */
  input?: Array<'text' | 'image'>;
  /** Context window and output cap of the routed endpoints; `undefined` when unknown. */
  limits?: OpenRouterModelLimits;
  providers: string[];
  bar: number | null;
  source: OpenRouterRoutingSource;
  /** The one daemon log line describing this decision. */
  line: string;
  /**
   * An expired qualified daily set is served while its replacement is built
   * in the background for the next activation. Never rejects.
   */
  refresh?: Promise<OpenRouterRoutingDecision | undefined>;
}

interface CachedRouting {
  policy?: string;
  model: string;
  fetchedAt: number;
  providers: string[];
  bar: number | null;
  /**
   * Three states, and the difference matters (C87): an array is the model's
   * known modalities, `null` records that the listing named none (so the entry
   * is still complete and re-asking would loop forever), and ABSENT marks an
   * entry written before C87 — never fresh, re-asked once.
   */
  input?: Array<'text' | 'image'> | null;
  /**
   * The same three states for the routed endpoints' limits: `null` when the
   * listing named no window, ABSENT for an entry written before the limits
   * were pinned (never fresh, re-asked once).
   */
  limits?: OpenRouterModelLimits | null;
}

/** One provider's answer to the probe. */
export interface OpenRouterProbeResult {
  provider: string;
  /** The provider returned non-empty completion text. */
  answered: boolean;
  latencyMs: number;
  /** Why it did not answer, for the log line ('empty completion', 'HTTP 429'…). */
  note?: string;
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

/**
 * Reduce the public endpoints payload to the per-endpoint reliability and
 * cache-pricing facts, plus the model's advertised input modalities (`undefined` when the listing does not name them).
 */
export function parseOpenRouterEndpoints(payload: unknown): {
  endpoints: OpenRouterEndpoint[];
  contextLength: number | undefined;
  inputModalities: string[] | undefined;
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
    const maxCompletionTokens =
      typeof endpoint.max_completion_tokens === 'number' ? endpoint.max_completion_tokens : 0;
    const supported = Array.isArray(endpoint.supported_parameters)
      ? endpoint.supported_parameters
      : [];
    const pricing = endpoint.pricing && typeof endpoint.pricing === 'object'
      ? endpoint.pricing as Record<string, unknown>
      : {};
    const promptPrice = tokenPrice(pricing.prompt);
    const cacheReadPrice = tokenPrice(pricing.input_cache_read);
    endpoints.push({
      provider,
      uptime,
      contextLength,
      maxCompletionTokens,
      tools: supported.includes('tools'),
      ...(typeof endpoint.provider_name === 'string' ? { providerName: endpoint.provider_name } : {}),
      ...(promptPrice === undefined ? {} : { promptPrice }),
      ...(cacheReadPrice === undefined ? {} : { cacheReadPrice }),
      discountedCacheRead:
        promptPrice !== undefined && cacheReadPrice !== undefined && cacheReadPrice < promptPrice,
    });
  }
  const architecture =
    record.architecture && typeof record.architecture === 'object'
      ? (record.architecture as Record<string, unknown>)
      : {};
  const modalities = Array.isArray(architecture.input_modalities)
    ? architecture.input_modalities.filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      )
    : undefined;
  return {
    endpoints,
    contextLength:
      typeof record.context_length === 'number'
        ? record.context_length
        : advertisedContextLength(endpoints),
    inputModalities: modalities?.length ? modalities : undefined,
  };
}

export interface OpenRouterProviderCost {
  provider: string;
  cacheShare: number;
  measuredCalls: number;
  /** USD per prompt token, weighted by this provider's measured cache reuse. */
  effectiveInputPrice: number;
}

/** Input cost is comparable at a common prompt size; latency never reorders providers. */
export function rankOpenRouterProviders(
  endpoints: readonly OpenRouterEndpoint[],
  contextLength: number | undefined,
  traffic: readonly OpenRouterProviderTraffic[],
  answered: readonly string[],
): OpenRouterProviderCost[] {
  const shares = traffic.filter((row) => row.promptTokens > 0).map((row) => row.cacheShare).sort((a, b) => a - b);
  const middle = Math.floor(shares.length / 2);
  // With no observations, assume a cold prompt rather than inventing savings.
  const medianShare = shares.length ? (shares[middle]! + shares[Math.floor((shares.length - 1) / 2)]!) / 2 : 0;
  const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ranked = new Map<string, OpenRouterProviderCost>();
  for (const endpoint of endpoints) {
    if (!endpoint.tools || endpoint.uptime < OPENROUTER_UPTIME_BAR_RELAXED ||
        (contextLength !== undefined && endpoint.contextLength < contextLength) ||
        !answered.includes(endpoint.provider) || endpoint.promptPrice === undefined) continue;
    const measured = traffic.find((row) => normalize(row.provider) === normalize(endpoint.providerName ?? endpoint.provider));
    const cacheShare = measured?.cacheShare ?? medianShare;
    const effectiveInputPrice = endpoint.promptPrice * (1 - cacheShare) +
      (endpoint.cacheReadPrice ?? endpoint.promptPrice) * cacheShare;
    const row = { provider: endpoint.provider, cacheShare, measuredCalls: measured?.calls ?? 0, effectiveInputPrice };
    if (!ranked.has(row.provider) || effectiveInputPrice < ranked.get(row.provider)!.effectiveInputPrice) ranked.set(row.provider, row);
  }
  return [...ranked.values()].sort((a, b) => a.effectiveInputPrice - b.effectiveInputPrice || a.provider.localeCompare(b.provider));
}

/** Missing/blank prices must not become zero through Number(null) or Number(''). */
function tokenPrice(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : undefined;
}

/**
 * The `input` list pi understands, from OpenRouter's modality names. pi accepts
 * only `text` and `image`; `video` and anything else it has no word for is
 * dropped rather than passed through and rejected by its config schema.
 */
export function piInputModalities(
  modalities: readonly string[] | undefined,
): Array<'text' | 'image'> | undefined {
  if (!modalities) return undefined;
  const input: Array<'text' | 'image'> = ['text'];
  if (modalities.includes('image')) input.push('image');
  return input;
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
  // A cache-capable provider at the relaxed bar is preferable to a cold one
  // at 100%. When none publish a usable discount, retain the uptime ladder
  // so models without caching remain usable.
  const caching = eligible.filter(
    (endpoint) => endpoint.discountedCacheRead && endpoint.uptime >= OPENROUTER_UPTIME_BAR_RELAXED,
  );
  const candidates = caching.length ? caching : eligible;
  const atBar = (bar: number): string[] => {
    const seen = new Set<string>();
    return candidates
      .filter((endpoint) => endpoint.uptime >= bar)
      .sort((left, right) => right.uptime - left.uptime)
      .map((endpoint) => endpoint.provider)
      .filter((provider) => (seen.has(provider) ? false : (seen.add(provider), true)));
  };
  const strict = atBar(OPENROUTER_UPTIME_BAR);
  // Keep a cache-capable endpoint through a small uptime dip even if two
  // alternatives clear the strict bar. Dropping it would evict a warm sticky
  // session; OpenRouter can handle its actual request failures itself.
  if (
    strict.length >= OPENROUTER_MIN_PROVIDERS &&
    (caching.length === 0 || caching.every((endpoint) => endpoint.uptime >= OPENROUTER_UPTIME_BAR))
  ) {
    return { providers: strict, bar: OPENROUTER_UPTIME_BAR, contextLength };
  }
  const relaxed = atBar(OPENROUTER_UPTIME_BAR_RELAXED);
  if (relaxed.length > 0) {
    return { providers: relaxed, bar: OPENROUTER_UPTIME_BAR_RELAXED, contextLength };
  }
  return { providers: [], bar: null, contextLength };
}

/**
 * The limits the routed providers can honour: the smallest window among the
 * providers' endpoints (OpenRouter may serve a request from any of them), and
 * an output cap of `OPENROUTER_MAX_OUTPUT_TOKENS`, lowered only when no routed
 * endpoint accepts that much. One endpoint with a tiny output limit does not
 * shrink every answer. `undefined` when no endpoint names a window.
 */
export function openRouterModelLimits(
  endpoints: readonly OpenRouterEndpoint[],
  providers: readonly string[],
): OpenRouterModelLimits | undefined {
  const routed = endpoints.filter((endpoint) => providers.includes(endpoint.provider));
  const windows = routed.map((endpoint) => endpoint.contextLength).filter((value) => value > 0);
  if (windows.length === 0) return undefined;
  const contextWindow = Math.min(...windows);
  const outputs = routed
    .map((endpoint) => endpoint.maxCompletionTokens)
    .filter((value) => value > 0);
  const maxTokens = Math.min(
    OPENROUTER_MAX_OUTPUT_TOKENS,
    contextWindow,
    outputs.length ? Math.max(...outputs) : OPENROUTER_MAX_OUTPUT_TOKENS,
  );
  return { contextWindow, maxTokens };
}

export function openRouterRoutingFor(
  providers: readonly string[],
  allowFallbacks = true,
): OpenRouterRouting {
  return {
    only: [...providers],
    // provider.order disables OpenRouter's session stickiness. Pi already
    // sends its session id; OpenRouter keeps the successful cache provider
    // and falls back on failure, within `only`, without bouncing to the old
    // first choice on every request. A recovery override remains explicit.
    ...(allowFallbacks ? {} : { order: [...providers] }),
    allow_fallbacks: allowFallbacks,
    require_parameters: false,
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
    const input = Array.isArray(cached.input)
      ? cached.input.filter(
          (value): value is 'text' | 'image' => value === 'text' || value === 'image',
        )
      : cached.input === null
        ? null
        : undefined;
    const limits = cached.limits === null ? null : cachedLimits(cached.limits);
    return {
      policy: typeof cached.policy === 'string' ? cached.policy : undefined,
      model,
      fetchedAt: cached.fetchedAt,
      providers: cached.providers,
      bar: typeof cached.bar === 'number' ? cached.bar : null,
      ...(input === undefined ? {} : { input: input && input.length ? input : null }),
      ...(limits === undefined ? {} : { limits }),
    };
  } catch {
    return undefined;
  }
}

function cachedLimits(value: unknown): OpenRouterModelLimits | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { contextWindow, maxTokens } = value as Partial<OpenRouterModelLimits>;
  if (typeof contextWindow !== 'number' || contextWindow <= 0) return undefined;
  if (typeof maxTokens !== 'number' || maxTokens <= 0) return undefined;
  return { contextWindow, maxTokens };
}

async function writeCache(cacheDir: string, value: CachedRouting): Promise<void> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await writeFile(cachePath(cacheDir, value.model), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * The one request the probe sends: a tool-enabled completion pinned to a
 * single provider with no fallbacks, asking for one word. Tools are declared
 * because a provider that silently drops tool calls is exactly the one this
 * pin must not contain; the model is told never to call it.
 */
const PROBE_TOOL = {
  type: 'function',
  function: {
    name: 'beeline_routing_probe',
    description: 'Never call this tool. It exists only to prove the endpoint accepts tools.',
    parameters: { type: 'object', properties: {} },
  },
} as const;

function completionText(payload: unknown): string {
  const choices = (payload as { choices?: unknown } | undefined)?.choices;
  if (!Array.isArray(choices)) return '';
  let text = '';
  for (const choice of choices) {
    const content = (choice as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof content === 'string') text += content;
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
          text += String((block as { text?: unknown }).text ?? '');
        }
      }
    }
  }
  return text.trim();
}

/**
 * Ask ONE provider for one word. `answered` is the only fact that matters: an
 * empty 200 is a failure here even though it is a success to OpenRouter's
 * uptime figure.
 */
export async function probeOpenRouterProvider(input: {
  model: string;
  provider: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): Promise<OpenRouterProbeResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const doFetch = input.fetchImpl ?? fetch;
  try {
    const response = await doFetch(OPENROUTER_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        provider: { only: [input.provider], allow_fallbacks: false, require_parameters: false },
        messages: [{ role: 'user', content: 'Reply with exactly one word: ready' }],
        max_tokens: 32,
        tools: [PROBE_TOOL],
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? OPENROUTER_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        provider: input.provider,
        answered: false,
        latencyMs: now() - started,
        note: `HTTP ${response.status}`,
      };
    }
    const text = completionText(await response.json());
    return {
      provider: input.provider,
      answered: Boolean(text),
      latencyMs: now() - started,
      ...(text ? {} : { note: 'empty completion' }),
    };
  } catch (error) {
    return {
      provider: input.provider,
      answered: false,
      latencyMs: now() - started,
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Ask the uptime survivors, in parallel and bounded, and keep only the ones
 * that answered. Measured latency is diagnostic only: it must not replace a
 * warm provider on the next activation.
 */
export async function probeOpenRouterProviders(input: {
  model: string;
  providers: readonly string[];
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxCandidates?: number;
}): Promise<OpenRouterProbeResult[]> {
  const candidates = input.providers.slice(
    0,
    input.maxCandidates ?? OPENROUTER_PROBE_MAX_CANDIDATES,
  );
  return Promise.all(
    candidates.map((provider) =>
      probeOpenRouterProvider({
        model: input.model,
        provider,
        apiKey: input.apiKey,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        ...(input.now ? { now: input.now } : {}),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      }),
    ),
  );
}

function decision(
  model: string,
  providers: readonly string[],
  bar: number | null,
  source: OpenRouterRoutingSource,
  note?: string,
  allowFallbacks = true,
  input?: Array<'text' | 'image'>,
  limits?: OpenRouterModelLimits,
): OpenRouterRoutingDecision {
  const criteria = bar === null ? 'fallback pair' : `uptime ≥${bar}%, tools`;
  const suffix = [
    bar === OPENROUTER_UPTIME_BAR_RELAXED && !note?.startsWith('daily')
      ? 'bar lowered: reliability fallback or cache continuity' : '',
    source === 'cache' ? 'cached' : '',
    source === 'stale-cache' ? 'stale cache' : '',
    note ?? '',
  ]
    .filter(Boolean)
    .join('; ');
  return {
    model,
    routing: openRouterRoutingFor(providers, allowFallbacks),
    ...(input ? { input } : {}),
    ...(limits ? { limits } : {}),
    providers: [...providers],
    bar,
    source,
    line:
      `[body] openrouter routing for ${model}: ${providers.join(', ')} (${criteria}` +
      (suffix ? `; ${suffix})` : ')'),
  };
}

/** What `prepareRoomAgentHome` accepts: the resolve input plus a decision hook. */
export interface OpenRouterRoutingHomeInput extends ResolveOpenRouterRoutingInput {
  onDecision?: (decision: OpenRouterRoutingDecision) => void;
}

export interface ResolveOpenRouterRoutingInput {
  model: string;
  cacheDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /**
   * OpenRouter key for the answer probe. Without it only the uptime/tools
   * filter runs — the pin is then no worse than it was before C92.
   */
  apiKey?: string;
  /**
   * Pin this ONE provider with no fallbacks, whatever the live data says. The
   * turn loops set it after an empty completion so the retry is served by a
   * named provider (`empty-turn.ts`).
   */
  providerOverride?: string;
  /** Bound on the probe; tests pass a smaller one. */
  probeMaxCandidates?: number;
  probeTimeoutMs?: number;
  /** This agent's Room homes; read-only session IDs for seven-day generation facts. */
  historyRoomsDir?: string;
}

/**
 * The uptime/tools pass: fresh cache → live API (cached on success) → any
 * cached set, however old → #840's pair. Never throws.
 */
async function resolveUptimeRouting(
  input: ResolveOpenRouterRoutingInput,
): Promise<OpenRouterRoutingDecision> {
  const now = input.now ?? Date.now;
  const cached = await readCache(input.cacheDir, input.model);
  // A pre-C87 cache entry has no modality field at all; re-ask once rather
  // than pin a model whose vision capability we never established. An entry
  // without limits or the cache-selection policy is re-asked the same way.
  if (
    cached?.policy === ROUTING_POLICY &&
    cached?.input !== undefined &&
    cached.limits !== undefined &&
    now() - cached.fetchedAt < OPENROUTER_ROUTING_CACHE_TTL_MS
  ) {
    return decision(
      input.model,
      cached.providers,
      cached.bar,
      'cache',
      undefined,
      true,
      cached.input ?? undefined,
      cached.limits ?? undefined,
    );
  }
  let failure: string;
  try {
    const doFetch = input.fetchImpl ?? fetch;
    const response = await doFetch(`${OPENROUTER_ENDPOINTS_BASE_URL}/${input.model}/endpoints`, {
      signal: AbortSignal.timeout(input.timeoutMs ?? OPENROUTER_ROUTING_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { endpoints, contextLength, inputModalities } = parseOpenRouterEndpoints(
      await response.json(),
    );
    const modelInput = piInputModalities(inputModalities);
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
        true,
        modelInput,
      );
    }
    // Keep the probe's bounded candidate pool stable across harmless uptime
    // fluctuations. A still-eligible provider should not lose its warm cache
    // merely because another provider now reports 100% rather than 99%.
    if (cached?.policy === ROUTING_POLICY) {
      const retained = cached.providers.filter((provider) => selected.providers.includes(provider));
      selected.providers = [
        ...retained,
        ...selected.providers.filter((provider) => !retained.includes(provider)),
      ];
    }
    const limits = openRouterModelLimits(endpoints, selected.providers);
    await writeCache(input.cacheDir, {
      policy: ROUTING_POLICY,
      model: input.model,
      fetchedAt: now(),
      providers: selected.providers,
      bar: selected.bar,
      // `null` when the listing named no modalities: an answer, not a gap.
      input: modelInput ?? null,
      limits: limits ?? null,
    }).catch(() => undefined);
    return decision(
      input.model,
      selected.providers,
      selected.bar,
      'live',
      undefined,
      true,
      modelInput,
      limits,
    );
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
      true,
      cached.input ?? undefined,
      cached.limits ?? undefined,
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

/** The daily, qualified top-three set, separate from legacy endpoint/probe caches. */
interface DailyRouting {
  policy: 'cost-daily-v1';
  model: string;
  fetchedAt: number;
  providers: string[];
  ranking: OpenRouterProviderCost[];
  input?: Array<'text' | 'image'>;
  limits?: OpenRouterModelLimits;
}

function dailyCachePath(input: ResolveOpenRouterRoutingInput): string {
  return resolve(input.cacheDir, `${input.model.replace(/[^A-Za-z0-9._-]+/g, '_')}.daily.json`);
}

async function readDailyRouting(input: ResolveOpenRouterRoutingInput): Promise<DailyRouting | undefined> {
  try {
    const row = JSON.parse(await readFile(dailyCachePath(input), 'utf8')) as DailyRouting;
    if (row.policy !== 'cost-daily-v1' || row.model !== input.model || !Number.isFinite(row.fetchedAt) ||
        !Array.isArray(row.providers) || !row.providers.length || row.providers.length > 3 ||
        !row.providers.every((provider) => typeof provider === 'string' && provider.length > 0) ||
        !Array.isArray(row.ranking) || !row.ranking.every((entry) => entry &&
          typeof entry.provider === 'string' && Number.isFinite(entry.effectiveInputPrice) && entry.effectiveInputPrice >= 0 &&
          Number.isFinite(entry.cacheShare) && entry.cacheShare >= 0 && entry.cacheShare <= 1) ||
        !row.providers.every((provider) => row.ranking.some((entry) => entry.provider === provider))) return undefined;
    return { policy: 'cost-daily-v1', model: row.model, fetchedAt: row.fetchedAt, providers: row.providers, ranking: row.ranking,
      ...(Array.isArray(row.input) ? { input: row.input.filter((value) => value === 'text' || value === 'image') } : {}),
      ...(cachedLimits(row.limits) ? { limits: cachedLimits(row.limits) } : {}) };
  } catch { return undefined; }
}

function dailyDecision(row: DailyRouting, source: OpenRouterRoutingSource): OpenRouterRoutingDecision {
  return decision(row.model, row.providers, OPENROUTER_UPTIME_BAR_RELAXED, source,
    'daily effective input cost; seven-day cache shares; answer-probed', true, row.input, row.limits);
}

/** A cold agent qualifies once; expired decisions refresh in the background for new activations. */
async function buildDailyRouting(input: ResolveOpenRouterRoutingInput): Promise<DailyRouting> {
  const now = input.now ?? Date.now;
  const response = await (input.fetchImpl ?? fetch)(`${OPENROUTER_ENDPOINTS_BASE_URL}/${input.model}/endpoints`, {
    signal: AbortSignal.timeout(input.timeoutMs ?? OPENROUTER_ROUTING_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { endpoints, contextLength, inputModalities } = parseOpenRouterEndpoints(await response.json());
  const eligible = [...new Set(endpoints.filter((endpoint) => endpoint.tools &&
    endpoint.uptime >= OPENROUTER_UPTIME_BAR_RELAXED && endpoint.promptPrice !== undefined &&
    (contextLength === undefined || endpoint.contextLength >= contextLength)).map((endpoint) => endpoint.provider))];
  if (!eligible.length) throw new Error('no priced provider met the tools/context/95% gate');
  const [traffic, probes] = await Promise.all([
    readOpenRouterTraffic({ model: input.model, cacheDir: input.cacheDir,
      ...(input.historyRoomsDir ? { roomsDir: input.historyRoomsDir } : {}),
      apiKey: input.apiKey!, now: now(), fetchImpl: input.fetchImpl, timeoutMs: input.timeoutMs }),
    probeOpenRouterProviders({ model: input.model, providers: eligible, apiKey: input.apiKey!,
      fetchImpl: input.fetchImpl, now: input.now, timeoutMs: input.probeTimeoutMs,
      // Gate every eligible provider once per day, rather than using the old
      // uptime-first six as a proxy for the cheapest qualified set.
      maxCandidates: input.probeMaxCandidates ?? eligible.length }),
  ]);
  const ranking = rankOpenRouterProviders(endpoints, contextLength, traffic,
    probes.filter((probe) => probe.answered).map((probe) => probe.provider));
  if (!ranking.length) throw new Error('no eligible provider answered the text probe');
  const providers = ranking.slice(0, 3).map((row) => row.provider);
  const row: DailyRouting = { policy: 'cost-daily-v1', model: input.model, fetchedAt: now(), providers, ranking,
    input: piInputModalities(inputModalities), limits: openRouterModelLimits(endpoints, providers) };
  await writePrivateFileAtomically(dailyCachePath(input), `${JSON.stringify(row, null, 2)}\n`).catch(() => undefined);
  return row;
}

// Keep completed attempts too: an unreachable API or unwritable disk must not
// turn the daily ranking into a per-activation retry/purchase loop.
const dailyAttempts = new Map<string, { startedAt: number; result: Promise<OpenRouterRoutingDecision> }>();

export async function resolveOpenRouterRouting(input: ResolveOpenRouterRoutingInput): Promise<OpenRouterRoutingDecision> {
  const cached = await readDailyRouting(input);
  const override = input.providerOverride?.trim();
  if (override) {
    const base = cached ? dailyDecision(cached, 'cache') : await resolveUptimeRouting(input);
    return decision(input.model, [override], base.bar, base.source,
      'pinned to one provider after an empty completion', false, base.input, base.limits);
  }
  // Without a credential we cannot buy the answer probe or read account
  // generations. Preserve the legacy reliability fallback for standalone use.
  if (!input.apiKey?.trim()) return resolveUptimeRouting(input);
  const now = input.now ?? Date.now;
  if (cached && now() - cached.fetchedAt < OPENROUTER_ROUTING_CACHE_TTL_MS) return dailyDecision(cached, 'cache');
  const key = `${input.cacheDir}\u0000${input.model}`;
  let attempt = dailyAttempts.get(key);
  if (!attempt || now() - attempt.startedAt >= OPENROUTER_ROUTING_CACHE_TTL_MS) {
    const result = buildDailyRouting(input).then((row) => dailyDecision(row, 'live')).catch(async (error) => {
      const base = cached ? dailyDecision(cached, 'stale-cache') : await resolveUptimeRouting(input);
      return { ...base, line: `${base.line}; daily ranking unavailable: ${error instanceof Error ? error.message : String(error)}` };
    });
    attempt = { startedAt: now(), result };
    dailyAttempts.set(key, attempt);
  }
  if (cached) return { ...dailyDecision(cached, 'stale-cache'), refresh: attempt.result };
  // The first pin needs real price/traffic facts and an affirmative probe.
  // Only this cold activation waits; retained sessions are never rewritten.
  return attempt.result;
}

/**
 * Pin ONE model inside pi's `models.json` without touching operator custom
 * providers or any other model: the routing lands on
 * `providers.openrouter.modelOverrides[<model>].compat.openRouterRouting`,
 * pi's topmost per-model layer, and the model's live input modalities land
 * beside it on the same override as `input` (C87 — without it a custom-model
 * entry defaults the model to text and pi strips every image from the prompt),
 * and the routed endpoints' `contextWindow` and `maxTokens` land there too.
 * With no model to pin, the object form still gains an empty `providers` map
 * (pi's schema requires the key).
 */
export function withOpenRouterModelRouting(
  value: unknown,
  pin:
    | {
        model: string;
        routing: OpenRouterRouting;
        input?: Array<'text' | 'image'>;
        /** `contextWindow` is absent when the listing named no window. */
        limits?: { contextWindow?: number; maxTokens: number };
      }
    | undefined,
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
    if (pin.input) override.input = pin.input;
    if (pin.limits?.contextWindow) override.contextWindow = pin.limits.contextWindow;
    if (pin.limits) override.maxTokens = pin.limits.maxTokens;
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
  extra?: {
    /** Retry pin after an empty completion (`empty-turn.ts`). */
    providerOverride?: string;
    /** Lets the turn loop learn the pinned order it may rotate through. */
    onDecision?: (decision: OpenRouterRoutingDecision) => void;
  },
): { openRouterRouting?: OpenRouterRoutingHomeInput } {
  const model = openRouterModelId(selection?.model, config.agentEnv);
  if (!model || !config.openRouterRoutingCacheDir) return {};
  const apiKey = config.agentEnv.OPENROUTER_API_KEY?.trim();
  return {
    openRouterRouting: {
      model,
      cacheDir: config.openRouterRoutingCacheDir,
      ...(apiKey ? { apiKey, historyRoomsDir: resolve(config.openRouterRoutingCacheDir, '../rooms') } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(extra?.providerOverride ? { providerOverride: extra.providerOverride } : {}),
      ...(extra?.onDecision ? { onDecision: extra.onDecision } : {}),
    },
  };
}
