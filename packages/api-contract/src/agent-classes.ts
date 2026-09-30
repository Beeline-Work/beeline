/**
 * Agent classes/tags: the vocabulary a workflow role or a corner reviewer
 * setting can name instead of one specific agent.
 *
 * Every agent carries a flat set of tag words: three automatic, non-removable
 * ones derived from its live configuration (its harness, an inferred
 * provider, and a weight tier derived from its selected model against the
 * workspace's family-pattern map), plus whatever custom tags a Workspace
 * admin attached. The model itself is also a tag, so a role can name an exact
 * model when that is more useful than a tier. A "class" and a "tag" are the
 * same thing here: `roleBindings`/`reviewerClass` name any word in that set,
 * and resolution (`apps/server/src/agent-classes.ts`) finds current Room
 * members whose tag set contains it.
 *
 * An identity id is always exactly 64 lowercase hex characters (`identities.id`
 * CHECK, `apps/server/src/database.ts`), so any other string is unambiguously
 * a class/tag reference rather than an agent id — no separate wire shape is
 * needed for "this role names a class instead of an agent."
 */

const IDENTITY_ID_PATTERN = /^[0-9a-f]{64}$/;

/** True for a real identity id; false for anything that must be a class/tag reference. */
export function isAgentIdentityReference(value: string): boolean {
  return IDENTITY_ID_PATTERN.test(value);
}

const CLASS_OR_TAG_REFERENCE_MAX_LENGTH = 128;
/** Loose enough to match a raw model id (dots, mixed case) as well as a tag word. */
const CLASS_OR_TAG_REFERENCE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

/** A role binding or reviewer setting naming a class/tag must look like this. */
export function isClassOrTagReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CLASS_OR_TAG_REFERENCE_MAX_LENGTH &&
    CLASS_OR_TAG_REFERENCE_PATTERN.test(value) &&
    !isAgentIdentityReference(value)
  );
}

// --- Custom tags (admin-editable, Workspace-scoped) -------------------------

const CUSTOM_TAG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const CUSTOM_TAGS_PER_AGENT_MAX = 16;

export function isCustomTag(value: unknown): value is string {
  return typeof value === 'string' && CUSTOM_TAG_PATTERN.test(value);
}

/** Parse `agents.custom_tags` (or an admin's proposed replacement); drop anything malformed. */
export function readCustomTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags = [...new Set(value.filter(isCustomTag))];
  return tags.slice(0, CUSTOM_TAGS_PER_AGENT_MAX);
}

// --- Weight tiers ------------------------------------------------------------

const WEIGHT_TIERS = ['god', 'heavy', 'light'] as const;
export type WeightTier = (typeof WEIGHT_TIERS)[number];

export function isWeightTier(value: unknown): value is WeightTier {
  return typeof value === 'string' && (WEIGHT_TIERS as readonly string[]).includes(value);
}

export type WeightTierRule = {
  readonly pattern: string;
  readonly tier: WeightTier;
};

const WEIGHT_TIER_RULE_PATTERN_MAX_LENGTH = 32;
export const WEIGHT_TIER_RULES_MAX = 64;
const RULE_PATTERN_SHAPE = new RegExp(`^[a-z0-9*.-]{1,${WEIGHT_TIER_RULE_PATTERN_MAX_LENGTH}}$`);

/**
 * Defaults from the captain's spec: the astra and fable families are the
 * heaviest tier; grok, the GPT "Sol" line (`*sol*`), and opus are heavy;
 * everything else is light. Order matters — the first matching rule wins, so
 * a workspace that customizes this list controls precedence by reordering it.
 *
 * `opus*`/`grok*`/`astra*`/`fable*` are PREFIX patterns on the exact stored
 * `selected_model` id, as the harness itself reports it — not a "contains"
 * match. If a harness prefixes Claude models with a vendor segment (e.g.
 * "claude-opus-..." rather than "opus-..."), a workspace admin adds a
 * `*opus*`-shaped rule ahead of this one in settings; nothing here assumes
 * one specific catalog naming convention.
 */
export const DEFAULT_WEIGHT_TIER_RULES: readonly WeightTierRule[] = [
  { pattern: 'astra*', tier: 'god' },
  { pattern: 'fable*', tier: 'god' },
  { pattern: 'grok*', tier: 'heavy' },
  { pattern: '*sol*', tier: 'heavy' },
  { pattern: 'opus*', tier: 'heavy' },
];

/** `*` matches any run of characters; everything else (incl. `.`/`-`) is literal. */
function familyPatternMatches(pattern: string, model: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === '*' ? '.*' : `\\${char}`));
  return new RegExp(`^${escaped}$`, 'i').test(model);
}

export function isWeightTierRule(value: unknown): value is WeightTierRule {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    typeof (value as WeightTierRule).pattern === 'string' &&
    RULE_PATTERN_SHAPE.test((value as WeightTierRule).pattern) &&
    isWeightTier((value as WeightTierRule).tier)
  );
}

/** Parse a workspace's stored/proposed rule list; `null`/invalid falls back to the defaults. */
export function readWeightTierRules(value: unknown): readonly WeightTierRule[] {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_WEIGHT_TIER_RULES;
  if (value.length > WEIGHT_TIER_RULES_MAX || !value.every(isWeightTierRule)) {
    return DEFAULT_WEIGHT_TIER_RULES;
  }
  return value as WeightTierRule[];
}

export type WeightTierResolution = {
  readonly tier: WeightTier;
  /** True when a real model name matched no rule — surfaced to admins, never to the assignment logic. */
  readonly unclassified: boolean;
};

/** First matching rule wins; no model selected yet is not "unclassified" — there's nothing to classify. */
export function resolveWeightTier(
  model: string | null | undefined,
  rules: readonly WeightTierRule[] = DEFAULT_WEIGHT_TIER_RULES,
): WeightTierResolution {
  if (!model) return { tier: 'light', unclassified: false };
  const match = rules.find((rule) => familyPatternMatches(rule.pattern, model));
  return match ? { tier: match.tier, unclassified: false } : { tier: 'light', unclassified: true };
}

// --- Harness / provider -------------------------------------------------------

/** Mirrors `apps/body/src/agent-command.ts`'s `AGENT_KINDS`; kept independent to avoid a body->contract dependency. */
const AGENT_HARNESSES = [
  'codex',
  'claude',
  'goose',
  'pi',
  'grok',
  'cursor',
  'opencode',
  'reference',
  'custom',
] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];

export function isAgentHarness(value: unknown): value is AgentHarness {
  return typeof value === 'string' && (AGENT_HARNESSES as readonly string[]).includes(value);
}

const HARNESS_NATIVE_PROVIDER: Partial<Record<AgentHarness, string>> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
};

/**
 * Best-effort inference, not a verified fact: a harness with its own native
 * backend (claude/codex/grok) always uses that provider; the others commonly
 * proxy through whichever provider the model prefix implies, defaulting to
 * openrouter (`AGENTS.md`'s OpenRouter-routing bullet) when nothing matches.
 * Nothing is stored for this — it is a pure function of already-known facts,
 * same as the weight tier.
 */
export function resolveProviderTag(harness: AgentHarness | null | undefined, model: string | null | undefined): string {
  if (harness && HARNESS_NATIVE_PROVIDER[harness]) return HARNESS_NATIVE_PROVIDER[harness]!;
  const name = (model ?? '').toLowerCase();
  if (!name) return 'unknown';
  if (name.startsWith('claude')) return 'anthropic';
  if (name.startsWith('gemini')) return 'google';
  if (name.startsWith('grok')) return 'xai';
  if (name.startsWith('gpt') || name.startsWith('o1') || name.startsWith('o3') || name.startsWith('codex')) {
    return 'openai';
  }
  return harness ? 'openrouter' : 'unknown';
}

// --- The unified tag set -------------------------------------------------------

export type AgentClassFacts = {
  readonly model: string | null;
  readonly harness: AgentHarness | null;
  readonly weightTier: WeightTier;
  readonly provider: string;
  readonly customTags: readonly string[];
};

/** Every word a role/reviewer class reference can match against this agent. */
export function agentTagSet(facts: AgentClassFacts): Set<string> {
  const tags = new Set<string>(facts.customTags);
  if (facts.model) tags.add(facts.model);
  if (facts.harness) tags.add(facts.harness);
  tags.add(facts.provider);
  tags.add(facts.weightTier);
  return tags;
}

export function agentMatchesClass(facts: AgentClassFacts, classOrTag: string): boolean {
  return agentTagSet(facts).has(classOrTag);
}
