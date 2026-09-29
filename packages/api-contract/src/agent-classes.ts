/**
 * Agent classes: the tags every agent carries and the weight tier among them.
 *
 * Automatic tags come from facts the system owns — the model the agent runs
 * (resolved against the models.dev registry), the harness its helper reports,
 * and the provider that model resolved under — and can never be edited.
 * Custom tags are written by Workspace admins only. A class is any one tag, so
 * "heavy", "opus", "claude-code" and a custom "reviewer" all name a class.
 *
 * Resolution is exact: a model id matches a registry id, or an alias's display
 * name matches a registry name. Nothing is ever classified by a substring of a
 * model id, so `gemma-4-31b-it-fabled` can never become `fable`.
 */

export const AGENT_TIERS = ['god', 'heavy', 'light'] as const;
export type AgentTier = (typeof AGENT_TIERS)[number];

/** Output price per 1M tokens, USD, at or above which a model is `god`. */
export const GOD_MIN_OUTPUT_USD = 40;
/** Output price per 1M tokens, USD, at or above which a model is `heavy`. */
export const HEAVY_MIN_OUTPUT_USD = 5;

export const UNCLASSIFIED_TAG = 'unclassified';
export const RESERVED_AGENT_TAGS: ReadonlySet<string> = new Set([...AGENT_TIERS, UNCLASSIFIED_TAG]);
export const CUSTOM_AGENT_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_CUSTOM_TAGS_PER_AGENT = 16;

export const MODELS_DEV_URL = 'https://models.dev/api.json';

export function isAgentTier(value: unknown): value is AgentTier {
  return typeof value === 'string' && (AGENT_TIERS as readonly string[]).includes(value);
}

export function tierFromOutputPrice(outputUsdPerMillion: number): AgentTier {
  if (outputUsdPerMillion >= GOD_MIN_OUTPUT_USD) return 'god';
  if (outputUsdPerMillion >= HEAVY_MIN_OUTPUT_USD) return 'heavy';
  return 'light';
}

/** A custom tag as stored, or an error naming why it is refused. */
export function normalizeCustomAgentTag(value: unknown): string {
  if (typeof value !== 'string') throw new Error('tag is invalid');
  const tag = value.trim().toLowerCase();
  if (!CUSTOM_AGENT_TAG_PATTERN.test(tag))
    throw new Error('tag is invalid: use 1-32 lowercase letters, digits or dashes');
  if (RESERVED_AGENT_TAGS.has(tag)) throw new Error(`tag is reserved: ${tag} is set by the system`);
  return tag;
}

/** A class names one tag: a tier (`heavy`) or any other tag (`reviewer`, `opus`). */
export function normalizeAgentClass(value: unknown): string {
  if (typeof value !== 'string') throw new Error('class is invalid');
  const tag = value.trim().toLowerCase();
  if (!CUSTOM_AGENT_TAG_PATTERN.test(tag)) throw new Error('class is invalid');
  return tag;
}

/** Harness tag from the helper's agent kind. */
export function harnessTag(agentKind: string | null | undefined): string | undefined {
  if (!agentKind) return undefined;
  const kind = agentKind.trim().toLowerCase();
  if (!kind) return undefined;
  if (kind === 'claude') return 'claude-code';
  if (kind === 'grok') return 'grok-cli';
  return kind;
}

/** Provider a harness runs when its helper does not name one. */
export function harnessDefaultProvider(agentKind: string | null | undefined): string | undefined {
  switch (agentKind) {
    case 'claude':
      return 'anthropic';
    case 'codex':
      return 'openai';
    case 'grok':
      return 'xai';
    default:
      return undefined;
  }
}

const VENDOR_FAMILY_PREFIXES = ['claude-', 'gpt-'];
const FIRST_PARTY_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'xai',
  'google',
  'deepseek',
  'mistral',
  'moonshotai',
  'zai',
]);

/**
 * The short family tag from the registry's own `family` field:
 * `claude-opus` -> `opus`, `gpt-sol` -> `sol`, `grok-build` -> `grok`,
 * `deepseek-flash` -> `deepseek`. The model id is never read.
 */
export function familyTag(family: string | null | undefined): string | undefined {
  const value = family?.trim().toLowerCase();
  if (!value) return undefined;
  for (const prefix of VENDOR_FAMILY_PREFIXES) {
    if (value.startsWith(prefix) && value.length > prefix.length) {
      return value.slice(prefix.length).split('-')[0] || undefined;
    }
  }
  return value.split('-')[0] || undefined;
}

export type RegistryModel = {
  readonly provider: string;
  readonly modelId: string;
  readonly name: string;
  readonly family: string | null;
  /** USD per 1M output tokens; null when the registry lists no output price. */
  readonly outputCost: number | null;
};

export type ModelTierOverride = {
  readonly scope: 'model' | 'family';
  /** `provider/modelId` for a model, the family tag for a family. */
  readonly key: string;
  readonly tier: AgentTier;
};

export function modelOverrideKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function normalizedModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A registry name with its leading vendor word dropped: "Claude Opus 5.5" -> "opus 5.5". */
function namesWithoutVendor(name: string): string[] {
  const normalized = normalizedModelName(name);
  const space = normalized.indexOf(' ');
  return space > 0 ? [normalized, normalized.slice(space + 1)] : [normalized];
}

export type ModelLookup = {
  /** The helper-reported or harness-default provider, when known. */
  readonly provider?: string;
  /** `agents.selected_model`, or the catalog's current value when none is persisted. */
  readonly modelId?: string;
  /** The catalog option's display name for that id (e.g. "Opus 5.5" for `opus`). */
  readonly displayName?: string;
};

/**
 * Resolve an agent's model against registry rows. `models` are the rows the
 * caller loaded for the candidate providers. Exact id first, then an id with a
 * leading `provider/` segment, then exact display-name equality for aliases.
 */
export function resolveRegistryModel(
  lookup: ModelLookup,
  models: readonly RegistryModel[],
): RegistryModel | undefined {
  const modelId = lookup.modelId?.trim();
  if (!modelId) return undefined;
  const sorted = [...models].sort((a, b) =>
    a.provider === b.provider
      ? a.modelId.localeCompare(b.modelId)
      : a.provider.localeCompare(b.provider),
  );
  const inProvider = (provider: string | undefined) =>
    provider ? sorted.filter((model) => model.provider === provider) : [];
  const provider = lookup.provider?.trim().toLowerCase();
  const exact = inProvider(provider).find((model) => model.modelId === modelId);
  if (exact) return exact;
  const slash = modelId.indexOf('/');
  if (slash > 0) {
    const prefix = modelId.slice(0, slash).toLowerCase();
    const rest = modelId.slice(slash + 1);
    const prefixed = inProvider(prefix).find((model) => model.modelId === rest);
    if (prefixed) return prefixed;
  }
  if (!provider) {
    // No provider hint (e.g. a multi-provider harness): an exact id counts only
    // when one first-party provider, or exactly one provider at all, lists it.
    const matches = sorted.filter((model) => model.modelId === modelId);
    const firstParty = matches.filter((model) => FIRST_PARTY_PROVIDERS.has(model.provider));
    if (firstParty.length === 1) return firstParty[0];
    if (new Set(matches.map((model) => model.provider)).size === 1) return matches[0];
  }
  const display = lookup.displayName ? normalizedModelName(lookup.displayName) : undefined;
  if (display && provider) {
    return inProvider(provider).find((model) => namesWithoutVendor(model.name).includes(display));
  }
  return undefined;
}

export type ModelClassification = {
  readonly tier: AgentTier;
  readonly unclassified: boolean;
  readonly source: 'model-override' | 'family-override' | 'price' | 'unlisted';
  readonly provider?: string;
  readonly modelId?: string;
  readonly family?: string;
  readonly outputCost?: number;
};

/**
 * Tier for one model. Precedence: a model override, then a family override,
 * then the registry's output price. A model the registry does not list (or
 * lists without an output price) is `light` and `unclassified` until an admin
 * pins it.
 */
export function classifyModel(
  input: {
    readonly provider?: string;
    readonly modelId?: string;
    readonly model?: RegistryModel;
  },
  overrides: readonly ModelTierOverride[],
): ModelClassification {
  const provider = input.model?.provider ?? input.provider;
  const modelId = input.model?.modelId ?? input.modelId;
  const family = familyTag(input.model?.family);
  const identity = {
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
    ...(family ? { family } : {}),
  };
  const modelOverride =
    provider && modelId
      ? overrides.find(
          (override) =>
            override.scope === 'model' && override.key === modelOverrideKey(provider, modelId),
        )
      : undefined;
  if (modelOverride)
    return { ...identity, tier: modelOverride.tier, unclassified: false, source: 'model-override' };
  const familyOverride = family
    ? overrides.find((override) => override.scope === 'family' && override.key === family)
    : undefined;
  if (familyOverride)
    return {
      ...identity,
      tier: familyOverride.tier,
      unclassified: false,
      source: 'family-override',
    };
  const cost = input.model?.outputCost;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
    return {
      ...identity,
      outputCost: cost,
      tier: tierFromOutputPrice(cost),
      unclassified: false,
      source: 'price',
    };
  return { ...identity, tier: 'light', unclassified: true, source: 'unlisted' };
}

export type AgentTagKind = 'tier' | 'status' | 'family' | 'harness' | 'provider' | 'custom';

export type AgentTagView = {
  readonly tag: string;
  readonly kind: AgentTagKind;
  /** Only custom tags are removable, and only by a Workspace admin. */
  readonly removable: boolean;
};

export type AgentClassView = {
  readonly tags: readonly AgentTagView[];
  readonly tier: AgentTier;
  readonly unclassified: boolean;
  readonly source: ModelClassification['source'];
  readonly provider?: string;
  readonly modelId?: string;
  readonly outputCost?: number;
};

/** The ordered tag list an agent carries: tier, unclassified, family, harness, provider, custom. */
export function agentTags(input: {
  readonly classification: ModelClassification;
  readonly harness?: string | null;
  readonly custom?: readonly string[];
}): AgentTagView[] {
  const tags: AgentTagView[] = [];
  const seen = new Set<string>();
  const push = (tag: string | undefined, kind: AgentTagKind) => {
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    tags.push({ tag, kind, removable: kind === 'custom' });
  };
  push(input.classification.tier, 'tier');
  if (input.classification.unclassified) push(UNCLASSIFIED_TAG, 'status');
  push(input.classification.family, 'family');
  push(harnessTag(input.harness), 'harness');
  push(input.classification.provider, 'provider');
  for (const tag of [...(input.custom ?? [])].sort()) push(tag, 'custom');
  return tags;
}

export function agentClassView(input: {
  readonly classification: ModelClassification;
  readonly harness?: string | null;
  readonly custom?: readonly string[];
}): AgentClassView {
  const { classification } = input;
  return {
    tags: agentTags(input),
    tier: classification.tier,
    unclassified: classification.unclassified,
    source: classification.source,
    ...(classification.provider ? { provider: classification.provider } : {}),
    ...(classification.modelId ? { modelId: classification.modelId } : {}),
    ...(classification.outputCost !== undefined ? { outputCost: classification.outputCost } : {}),
  };
}

/**
 * Parse the models.dev `api.json` body into registry rows. Anything that does
 * not have the documented shape is skipped rather than trusted.
 */
export function parseModelsDevRegistry(body: unknown): RegistryModel[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const rows: RegistryModel[] = [];
  for (const [providerKey, providerValue] of Object.entries(body as Record<string, unknown>)) {
    if (!providerValue || typeof providerValue !== 'object') continue;
    const models = (providerValue as { models?: unknown }).models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
    const provider = providerKey.trim().toLowerCase();
    if (!provider || provider.length > 128) continue;
    for (const [modelKey, modelValue] of Object.entries(models as Record<string, unknown>)) {
      if (!modelValue || typeof modelValue !== 'object') continue;
      const model = modelValue as {
        id?: unknown;
        name?: unknown;
        family?: unknown;
        cost?: { output?: unknown } | null;
      };
      const modelId = typeof model.id === 'string' && model.id ? model.id : modelKey;
      if (!modelId || modelId.length > 256) continue;
      const output = model.cost && typeof model.cost === 'object' ? model.cost.output : undefined;
      rows.push({
        provider,
        modelId,
        name: typeof model.name === 'string' ? model.name.slice(0, 256) : modelId,
        family: typeof model.family === 'string' && model.family ? model.family.slice(0, 128) : null,
        outputCost:
          typeof output === 'number' && Number.isFinite(output) && output >= 0 ? output : null,
      });
    }
  }
  return rows;
}
