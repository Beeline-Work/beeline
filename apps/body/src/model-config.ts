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
    const choices = rawChoices
      .filter(
        (choice): choice is Record<string, unknown> =>
          Boolean(choice) && typeof choice === 'object' && typeof (choice as any).id === 'string',
      )
      .map((choice) => ({
        id: choice.id as string,
        ...(typeof choice.name === 'string' ? { name: choice.name } : {}),
      }));
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
    throw new Error(`model config value "${value}" is not one of "${configId}"'s advertised options`);
  }
}

/**
 * Where a `{model, effort}` selection lands among a session's advertised
 * axes. `effort` is deliberately matched against whichever of
 * `thought_level`/`effort`/`reasoning_effort` a harness actually advertises
 * (claude: effort, codex: reasoning_effort, pi: thought_level) — the
 * category name, not the harness, decides the match, so no per-harness
 * branching is needed here or in any caller.
 */
function modelSelectionTargets(
  selection: { model?: string; effort?: string },
): Array<{ categories: readonly string[]; label: string; value: string | undefined }> {
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
 * Validate a `{model, effort}` selection against a session's RAW advertised
 * catalog and throw a clear, specific error for the first axis that is
 * missing or whose value isn't advertised. Unlike `applyAgentModelSelection`
 * (which logs and skips so a bad in-app pick can never abort a live
 * session), this is for a context — pairing — where a bad selection must
 * fail loudly instead of silently launching with the wrong default.
 */
export function assertModelSelectionAdvertised(
  advertisedOptions: AgentModelConfigOption[],
  selection: { model?: string; effort?: string },
): void {
  for (const target of modelSelectionTargets(selection)) {
    if (!target.value) continue;
    const axis = advertisedOptions.find((option) => target.categories.includes(option.category));
    if (!axis) {
      throw new Error(`this agent does not advertise a selectable ${target.label}`);
    }
    assertModelConfigOptionAllowed(axis.id, target.value, advertisedOptions);
  }
}

/** Minimal shape `applyAgentModelSelection` needs from an ACP client. */
export interface ModelConfigSettable {
  setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown>;
}

/**
 * Apply a persisted `{model, effort}` selection to a live ACP session. Each
 * target category group is only ever searched among the RAW advertised
 * axes, and every candidate set is re-validated by
 * `assertModelConfigOptionAllowed` immediately before the call — a
 * disallowed or stale selection is skipped (logged), never thrown past this
 * point, so one bad axis can't abort session startup.
 */
export async function applyAgentModelSelection(
  client: ModelConfigSettable,
  sessionId: string,
  advertisedOptions: AgentModelConfigOption[],
  selection: { model?: string; effort?: string },
): Promise<void> {
  for (const target of modelSelectionTargets(selection)) {
    if (!target.value) continue;
    const axis = advertisedOptions.find((option) => target.categories.includes(option.category));
    if (!axis) continue;
    try {
      assertModelConfigOptionAllowed(axis.id, target.value, advertisedOptions);
    } catch (error) {
      console.error('[body] refusing to apply disallowed model config option:', error);
      continue;
    }
    await client.setConfigOption(sessionId, axis.id, target.value);
  }
}
