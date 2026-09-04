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
 *   allow_fallbacks: true WITHIN the set, require_parameters: false (a
 *          provider may ignore a sampling knob it does not know; with `true`
 *          OpenRouter answers pi's full parameter set — stop, top_p, reasoning,
 *          tool_choice… — with 404 "No endpoints found that can handle the
 *          requested parameters" for every provider, the live 2026-09-03 fault;
 *          the `tools` filter above already guarantees tool calling)
 *
 * The result is cached per model for 24h (`<cacheDir>/<model>.json`), read
 * back when the API is unreachable (stale is better than blind), and applied
 * to that one model's entry in the agent's pi `models.json` — never globally.
 *
 * Uptime is not the same fact as an answer (C92). Measured live on
 * 2026-09-04 for `z-ai/glm-5.3-flash`, half the pinned set accepted a
 * tool-enabled request and returned an EMPTY completion — a 200 OK that keeps
 * the provider's uptime at 100%, never triggers OpenRouter's own fallback, and
 * reaches the Room as a turn that says nothing. So the uptime/tools filter is
 * only the first pass: the survivors are then ASKED, one small tool-enabled
 * request each with `allow_fallbacks: false`, and only the ones that answer
 * with text are pinned, ordered by measured latency. That probe costs money
 * and time, so it is bounded (`OPENROUTER_PROBE_MAX_CANDIDATES`, run in
 * parallel with a short timeout), cached beside the uptime set
 * (`<cacheDir>/<model>.probe.json`, its own TTL), and NEVER blocks a turn: a
 * cold probe cache returns the uptime order immediately and refreshes in the
 * background for the next activation.
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
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const OPENROUTER_ENDPOINTS_BASE_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_ROUTING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const OPENROUTER_ROUTING_FETCH_TIMEOUT_MS = 10_000;
/** The answer probe is a live purchase; keep it short-lived but not per-turn. */
export const OPENROUTER_PROBE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** At most this many uptime survivors are ever asked, in parallel. */
export const OPENROUTER_PROBE_MAX_CANDIDATES = 6;
export const OPENROUTER_PROBE_TIMEOUT_MS = 20_000;
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
  /**
   * The model's input modalities in pi's vocabulary, pinned beside the
   * providers so a custom-model entry cannot silently downgrade a
   * vision-capable model to text (C87). `undefined` when the listing did not
   * name them — the pin then leaves `input` alone.
   */
  input?: Array<'text' | 'image'>;
  providers: string[];
  bar: number | null;
  source: OpenRouterRoutingSource;
  /** The one daemon log line describing this decision. */
  line: string;
  /**
   * Present only when the answer probe could not be served from cache: it is
   * running in the background and resolves to the decision the NEXT activation
   * will get. Never rejects, and never awaited on the turn path.
   */
  refresh?: Promise<OpenRouterRoutingDecision | undefined>;
}

interface CachedRouting {
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

interface CachedProbe {
  model: string;
  fetchedAt: number;
  /** Only the providers that answered, ordered by measured latency. */
  answered: { provider: string; latencyMs: number }[];
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
 * Reduce the public endpoints payload to the facts the pin needs: the four
 * per-endpoint reliability facts, plus the model's advertised input
 * modalities (`undefined` when the listing does not name them).
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
    const supported = Array.isArray(endpoint.supported_parameters)
      ? endpoint.supported_parameters
      : [];
    endpoints.push({ provider, uptime, contextLength, tools: supported.includes('tools') });
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

export function openRouterRoutingFor(
  providers: readonly string[],
  allowFallbacks = true,
): OpenRouterRouting {
  return {
    only: [...providers],
    order: [...providers],
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
    return {
      model,
      fetchedAt: cached.fetchedAt,
      providers: cached.providers,
      bar: typeof cached.bar === 'number' ? cached.bar : null,
      ...(input === undefined ? {} : { input: input && input.length ? input : null }),
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

function probeCachePath(cacheDir: string, model: string): string {
  return resolve(cacheDir, `${model.replace(/[^A-Za-z0-9._-]+/g, '_')}.probe.json`);
}

async function readProbeCache(cacheDir: string, model: string): Promise<CachedProbe | undefined> {
  try {
    const parsed = JSON.parse(await readFile(probeCachePath(cacheDir, model), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const cached = parsed as Partial<CachedProbe>;
    if (cached.model !== model || typeof cached.fetchedAt !== 'number') return undefined;
    if (!Array.isArray(cached.answered)) return undefined;
    const answered: CachedProbe['answered'] = [];
    for (const entry of cached.answered) {
      if (!entry || typeof entry !== 'object') return undefined;
      const { provider, latencyMs } = entry as { provider?: unknown; latencyMs?: unknown };
      if (typeof provider !== 'string' || !provider || typeof latencyMs !== 'number') {
        return undefined;
      }
      answered.push({ provider, latencyMs });
    }
    return { model, fetchedAt: cached.fetchedAt, answered };
  } catch {
    return undefined;
  }
}

async function writeProbeCache(cacheDir: string, value: CachedProbe): Promise<void> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await writeFile(probeCachePath(cacheDir, value.model), `${JSON.stringify(value, null, 2)}\n`, {
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
 * that answered — fastest first. Order is the measured latency, so the pin's
 * head is the provider that actually replies soonest.
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
    routing: openRouterRoutingFor(providers, allowFallbacks),
    ...(input ? { input } : {}),
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
  // than pin a model whose vision capability we never established.
  if (cached?.input !== undefined && now() - cached.fetchedAt < OPENROUTER_ROUTING_CACHE_TTL_MS) {
    return decision(
      input.model,
      cached.providers,
      cached.bar,
      'cache',
      undefined,
      true,
      cached.input ?? undefined,
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
    await writeCache(input.cacheDir, {
      model: input.model,
      fetchedAt: now(),
      providers: selected.providers,
      bar: selected.bar,
      // `null` when the listing named no modalities: an answer, not a gap.
      input: modelInput ?? null,
    }).catch(() => undefined);
    return decision(
      input.model,
      selected.providers,
      selected.bar,
      'live',
      undefined,
      true,
      modelInput,
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
 * One in-flight probe per (cache dir, model). Every Room of a daemon shares
 * the cache, so without this a restart would ask each provider once per Room.
 */
const inFlightProbes = new Map<string, Promise<OpenRouterRoutingDecision | undefined>>();

/** The probed set, restricted to providers the current uptime pass still keeps. */
function answeringProviders(probe: CachedProbe, candidates: readonly string[]): string[] {
  return probe.answered
    .map((entry) => entry.provider)
    .filter((provider) => candidates.includes(provider));
}

async function refreshAnswerProbe(
  input: ResolveOpenRouterRoutingInput,
  base: OpenRouterRoutingDecision,
  apiKey: string,
): Promise<OpenRouterRoutingDecision | undefined> {
  const now = input.now ?? Date.now;
  const results = await probeOpenRouterProviders({
    model: input.model,
    providers: base.providers,
    apiKey,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.probeTimeoutMs === undefined ? {} : { timeoutMs: input.probeTimeoutMs }),
    ...(input.probeMaxCandidates === undefined ? {} : { maxCandidates: input.probeMaxCandidates }),
  });
  const answered = results
    .filter((result) => result.answered)
    .sort((left, right) => left.latencyMs - right.latencyMs)
    .map((result) => ({ provider: result.provider, latencyMs: result.latencyMs }));
  const silent = results.filter((result) => !result.answered);
  if (answered.length === 0) {
    // Nobody answered: that is a fact about this moment, not about the set.
    // Do not cache it — the uptime order stays in force and the next
    // activation asks again.
    return undefined;
  }
  await writeProbeCache(input.cacheDir, {
    model: input.model,
    fetchedAt: now(),
    answered,
  }).catch(() => undefined);
  const dropped = silent.length
    ? `dropped ${silent.map((result) => `${result.provider} (${result.note ?? 'no answer'})`).join(', ')}`
    : 'every candidate answered';
  return decision(
    input.model,
    answered.map((entry) => entry.provider),
    base.bar,
    base.source,
    `answer-probed, fastest first; ${dropped}`,
    true,
    base.input,
  );
}

/**
 * The pin a daemon activation applies. The uptime ladder chooses the
 * candidates; the answer probe (cached separately, refreshed in the
 * background) reduces them to the providers that actually reply. Never
 * throws, and never waits on the probe: the decision's `line` is the one log
 * line a caller prints, and `refresh` — when present — is the background probe
 * whose own line the caller may print when it lands.
 */
export async function resolveOpenRouterRouting(
  input: ResolveOpenRouterRoutingInput,
): Promise<OpenRouterRoutingDecision> {
  const base = await resolveUptimeRouting(input);
  const override = input.providerOverride?.trim();
  if (override) {
    return decision(
      input.model,
      [override],
      base.bar,
      base.source,
      'pinned to one provider after an empty completion',
      false,
      base.input,
    );
  }
  const apiKey = input.apiKey?.trim();
  if (!apiKey || base.providers.length < 2) return base;
  const now = input.now ?? Date.now;
  const probe = await readProbeCache(input.cacheDir, input.model);
  if (probe && now() - probe.fetchedAt < OPENROUTER_PROBE_CACHE_TTL_MS) {
    const answered = answeringProviders(probe, base.providers);
    if (answered.length > 0) {
      return decision(
        input.model,
        answered,
        base.bar,
        base.source,
        'answer-probed, cached',
        true,
        base.input,
      );
    }
  }
  // Cold or unusable probe cache: the turn starts NOW on the uptime order and
  // the probe lands for the next activation.
  const key = `${input.cacheDir}\u0000${input.model}`;
  let refresh = inFlightProbes.get(key);
  if (!refresh) {
    const tracked: Promise<OpenRouterRoutingDecision | undefined> = refreshAnswerProbe(
      input,
      base,
      apiKey,
    )
      .catch(() => undefined)
      .finally(() => {
        if (inFlightProbes.get(key) === tracked) inFlightProbes.delete(key);
      });
    inFlightProbes.set(key, tracked);
    refresh = tracked;
  }
  return { ...base, refresh };
}

/**
 * Pin ONE model inside pi's `models.json` without touching operator custom
 * providers or any other model: the routing lands on
 * `providers.openrouter.modelOverrides[<model>].compat.openRouterRouting`,
 * pi's topmost per-model layer, and the model's live input modalities land
 * beside it on the same override as `input` (C87 — without it a custom-model
 * entry defaults the model to text and pi strips every image from the prompt).
 * With no model to pin, the object form still gains an empty `providers` map
 * (pi's schema requires the key).
 */
export function withOpenRouterModelRouting(
  value: unknown,
  pin:
    | { model: string; routing: OpenRouterRouting; input?: Array<'text' | 'image'> }
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
      ...(apiKey ? { apiKey } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(extra?.providerOverride ? { providerOverride: extra.providerOverride } : {}),
      ...(extra?.onDecision ? { onDecision: extra.onDecision } : {}),
    },
  };
}
