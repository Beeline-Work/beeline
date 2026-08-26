/**
 * Per-agent model/effort picker: capture the raw catalog an ACP `session/new`
 * advertises, filter it down to what's safe and reachable, and gate the
 * `session/set_config_option` set path.
 *
 * SECURITY INVARIANT (report `data/buzzy-multiagent-runtimes/report.md` §3.3):
 * `configOptions` also carries a `mode` category — Beeline's entire
 * read-only/edit boundary is `session/set_mode` picking `read-only` vs
 * `edit` (`acp.ts`'s `applySessionMode`). If the picker ever surfaced or set
 * `mode`/`fast-mode`/`collaboration_mode`, a user could flip an agent to
 * bypass the corner authority boundary. `isAllowedAgentModelConfigCategory`
 * (from `@beeline/buzz-client`, shared with the mobile client so both ends of
 * the picker enforce the same allow-list) is the one gate, and
 * `assertModelConfigOptionAllowed` re-checks it independently against the
 * RAW advertised catalog every time something is about to be set — so even a
 * caller that forgot to filter first still cannot reach `mode`.
 */
import {
  isAllowedAgentModelConfigCategory,
  type AgentModelConfigOption,
} from '@beeline/buzz-client';

/**
 * The identifier a `configOptions` choice actually carries.
 *
 * Claude-agent-acp (and #226's fake pair-cli fixture) spell it `id`.
 * Codex-acp spells it `value` and has no `id` at all — requiring `id` made a
 * successful Codex catalog fetch look empty, so the pair pickers never ran.
 */
export function advertisedChoiceId(choice: Record<string, unknown>): string | undefined {
  if (typeof choice.id === 'string' && choice.id.length > 0) return choice.id;
  if (typeof choice.value === 'string' && choice.value.length > 0) return choice.value;
  return undefined;
}

/** Parse every configOptions axis a raw `session/new` result advertised, unfiltered. */
export function parseAdvertisedConfigOptions(raw: unknown): AgentModelConfigOption[] {
  const configOptions = (raw as { configOptions?: unknown } | undefined)?.configOptions;
  if (!Array.isArray(configOptions)) return [];
  const result: AgentModelConfigOption[] = [];
  for (const entry of configOptions) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const category = record.category;
    if (typeof id !== 'string' || typeof category !== 'string') continue;
    const rawChoices = Array.isArray(record.options) ? record.options : [];
    const choices: AgentModelConfigOption['options'] = [];
    for (const rawChoice of rawChoices) {
      if (!rawChoice || typeof rawChoice !== 'object') continue;
      const choice = rawChoice as Record<string, unknown>;
      const choiceId = advertisedChoiceId(choice);
      if (!choiceId) continue;
      choices.push({
        id: choiceId,
        ...(typeof choice.name === 'string' ? { name: choice.name } : {}),
      });
    }
    result.push({
      id,
      category,
      ...(typeof record.currentValue === 'string' ? { currentValue: record.currentValue } : {}),
      options: choices,
    });
  }
  return result;
}

/** The security-invariant filter: drop every axis outside the picker's allow-list. */
export function filterAllowedModelConfigOptions(
  options: AgentModelConfigOption[],
): AgentModelConfigOption[] {
  return options.filter((option) => isAllowedAgentModelConfigCategory(option.category));
}

/**
 * Known provider credential env-var hints, used only to trim a leaky
 * advertised model list (pi alone advertises ~392 `openrouter/*` entries,
 * many for providers the account may not cover) down to what this runtime
 * can actually reach. Self-maintaining by design (captain decision #2 — no
 * curated model allow-list): this only asks "is there a key for this
 * provider", never which specific models are sanctioned.
 */
const PROVIDER_CREDENTIAL_ENV_HINTS: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY', 'OPENAI_COMPAT_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  xai: ['XAI_API_KEY'],
  cohere: ['COHERE_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
};

function credentialedProviders(env: Record<string, string>): Set<string> {
  const held = new Set<string>();
  for (const [provider, names] of Object.entries(PROVIDER_CREDENTIAL_ENV_HINTS)) {
    if (names.some((name) => Boolean(env[name]?.trim()))) held.add(provider);
  }
  return held;
}

/**
 * A `model` axis's choices are sometimes namespaced `provider/model-id`
 * (pi's catalog) and sometimes bare harness-native ids with no provider
 * prefix (codex/claude's own families) — a bare id always passes through,
 * since it needs no external credential the runtime doesn't already hold to
 * run at all. Non-`model` axes (effort/thought-level) are never namespaced
 * and pass through unchanged.
 */
export function filterModelOptionsByCredentials(
  options: AgentModelConfigOption[],
  env: Record<string, string>,
): AgentModelConfigOption[] {
  const held = credentialedProviders(env);
  return options.map((option) => {
    if (option.category !== 'model') return option;
    return {
      ...option,
      options: option.options.filter((choice) => {
        const slash = choice.id.indexOf('/');
        if (slash < 0) return true;
        return held.has(choice.id.slice(0, slash));
      }),
    };
  });
}

export class DisallowedModelConfigOptionError extends Error {
  constructor(configId: string) {
    super(`model config option "${configId}" is not in the allow-listed catalog`);
    this.name = 'DisallowedModelConfigOptionError';
  }
}

/**
 * The set path's security gate. Takes the RAW advertised catalog (not
 * pre-filtered) and independently re-derives the allow-list check, so a
 * `mode`/`fast-mode`/`collaboration_mode` axis is refused here even if an
 * upstream filtering step were ever skipped or buggy.
 */
export function assertModelConfigOptionAllowed(
  configId: string,
  value: string,
  advertisedOptions: AgentModelConfigOption[],
): void {
  const axis = advertisedOptions.find((option) => option.id === configId);
  if (!axis || !isAllowedAgentModelConfigCategory(axis.category)) {
    throw new DisallowedModelConfigOptionError(configId);
  }
  if (!axis.options.some((choice) => choice.id === value)) {
    throw new Error(
      `model config value "${value}" is not one of "${configId}"'s advertised options`,
    );
  }
}

export type ModelSelectionLabel = 'model' | 'effort';

export class ModelSelectionUnavailableError extends Error {
  readonly label: ModelSelectionLabel;
  readonly value: string;
  readonly reason: 'axis-missing' | 'not-advertised' | 'provider-refused';
  readonly guidance?: string;

  constructor(input: {
    label: ModelSelectionLabel;
    value: string;
    reason: 'axis-missing' | 'not-advertised' | 'provider-refused';
    guidance?: string;
  }) {
    const recovery = input.guidance
      ? ` ${input.guidance}`
      : ' Choose one of the values in the live harness catalog.';
    super(`${input.label} "${input.value}" is unavailable.${recovery}`);
    this.name = 'ModelSelectionUnavailableError';
    this.label = input.label;
    this.value = input.value;
    this.reason = input.reason;
    this.guidance = input.guidance;
  }
}

/**
 * The published catalog's per-axis `currentValue` must name what the agent
 * will actually run with, not the harness's pre-application default: the
 * daemon applies its selection AFTER `session/new` reports those values, so
 * an un-overridden snapshot would show the app a value that is about to be
 * replaced. Returns a shallow-copied option list with the effective
 * selection's value stamped onto each matching axis.
 */
export function withEffectiveCurrentValues(
  options: AgentModelConfigOption[],
  selection: { model?: string; effort?: string } | null | undefined,
): AgentModelConfigOption[] {
  if (!selection || (!selection.model && !selection.effort)) return options;
  return options.map((option) => {
    const target = modelSelectionTargets(selection).find((entry) =>
      entry.categories.includes(option.category),
    );
    if (!target?.value || option.currentValue === target.value) return option;
    return { ...option, currentValue: target.value };
  });
}

/**
 * Where a `{model, effort}` selection lands among a session's advertised
 * axes. `effort` is deliberately matched against whichever of
 * `thought_level`/`effort`/`reasoning_effort` a harness actually advertises
 * (claude: effort, codex: reasoning_effort, pi: thought_level) — the
 * category name, not the harness, decides the match, so no per-harness
 * branching is needed here or in any caller.
 */
function modelSelectionTargets(selection: {
  model?: string;
  effort?: string;
}): Array<{ categories: readonly string[]; label: string; value: string | undefined }> {
  return [
    { categories: ['model'], label: 'model', value: selection.model },
    {
      categories: ['thought_level', 'effort', 'reasoning_effort'],
      label: 'effort',
      value: selection.effort,
    },
  ];
}

/**
 * The one value-level authority for pair-time, daemon-start, and live-session
 * application. A selection is valid only when the selected harness advertises
 * both its axis and its exact value in the current credential-filtered catalog.
 */
export function assertModelSelectionAdvertised(
  advertisedOptions: AgentModelConfigOption[],
  selection: { model?: string; effort?: string },
): void {
  for (const target of modelSelectionTargets(selection)) {
    if (!target.value) continue;
    const axis = advertisedOptions.find((option) => target.categories.includes(option.category));
    if (!axis) {
      throw new ModelSelectionUnavailableError({
        label: target.label as ModelSelectionLabel,
        value: target.value,
        reason: 'axis-missing',
        guidance: `This harness does not advertise a selectable ${target.label} axis.`,
      });
    }
    assertModelConfigAxisAllowed(axis.id, advertisedOptions);
    if (!axis.options.some((choice) => choice.id === target.value)) {
      throw new ModelSelectionUnavailableError({
        label: target.label as ModelSelectionLabel,
        value: target.value,
        reason: 'not-advertised',
      });
    }
  }
}

/**
 * The set path's axis-level security gate: `configId` must exist in the raw
 * advertised catalog AND its category must be picker allow-listed. Unlike
 * `assertModelConfigOptionAllowed` it says nothing about the value because
 * `assertModelSelectionAdvertised` owns that check; a `mode`/`fast-mode` axis
 * is refused whatever value it would carry.
 */
export function assertModelConfigAxisAllowed(
  configId: string,
  advertisedOptions: AgentModelConfigOption[],
): void {
  const axis = advertisedOptions.find((option) => option.id === configId);
  if (!axis || !isAllowedAgentModelConfigCategory(axis.category)) {
    throw new DisallowedModelConfigOptionError(configId);
  }
}

/** Minimal shape `applyAgentModelSelection` needs from an ACP client. */
export interface ModelConfigSettable {
  setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown>;
}

/**
 * Apply a persisted `{model, effort}` selection to a live ACP session. Each
 * target category group is only ever searched among the RAW advertised
 * axes, and the axis itself is re-validated against the category allow-list
 * immediately before every call — a `mode`/`fast-mode` axis is refused here
 * even if an upstream filtering step were skipped.
 *
 * Values are checked before any setter call. A harness refusal for an exact
 * advertised value is surfaced as typed unavailability so provider retirement
 * redirects and other useful recovery guidance are not collapsed into a
 * generic turn failure.
 */
export async function applyAgentModelSelection(
  client: ModelConfigSettable,
  sessionId: string,
  advertisedOptions: AgentModelConfigOption[],
  selection: { model?: string; effort?: string },
): Promise<void> {
  assertModelSelectionAdvertised(advertisedOptions, selection);
  for (const target of modelSelectionTargets(selection)) {
    if (!target.value) continue;
    const axis = advertisedOptions.find((option) => target.categories.includes(option.category));
    if (!axis) continue;
    assertModelConfigAxisAllowed(axis.id, advertisedOptions);
    try {
      await client.setConfigOption(sessionId, axis.id, target.value);
    } catch (error) {
      throw new ModelSelectionUnavailableError({
        label: target.label as ModelSelectionLabel,
        value: target.value,
        reason: 'provider-refused',
        guidance: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
