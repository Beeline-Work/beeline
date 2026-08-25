/**
 * Interactive clack pickers for the per-agent settings `beeline pair` can
 * set: model, effort/thinking level, access scope, and (when access is
 * `creator`) the non-permitted-questioner auto-response. Each has a matching
 * CLI flag (`--model`/`--effort`/`--access`/`--auto-response`); a picker only
 * runs when its flag was omitted AND the session is a real TTY on both ends
 * (`cli.ts`'s `interactiveUi`) — never on a non-TTY stream, which would just
 * hang. The ordering the pair flow uses is agent -> model -> effort ->
 * access -> auto-response.
 */
import * as clack from '@clack/prompts';
import type { AgentModelConfigOption } from '@beeline/buzz-client';
import type { AgentCommand } from './agent-command.js';
import {
  DEFAULT_ACCESS_AUTO_RESPONSE,
  DEFAULT_ACCESS_POLICY,
  type AgentAccessPolicy,
} from './access-policy.js';
import { unwrapPrompt } from './clack-support.js';
import { fetchAgentModelCatalog } from './model-catalog.js';

export const EFFORT_AXIS_CATEGORIES = ['thought_level', 'effort', 'reasoning_effort'] as const;

/** Sentinel option value that switches the EFFORT picker to a free-text level. */
const CUSTOM_CHOICE = '__beeline-custom__';

/**
 * How many filtered choices the searchable model list shows at once before
 * clack's internal scrolling kicks in.
 */
const SEARCH_MAX_ITEMS = 12;

/** Case-insensitive substring match across a choice's id AND display name. */
function searchMatchesChoice(input: string, choice: { id: string; name?: string }): boolean {
  const needle = input.trim().toLowerCase();
  return (
    choice.id.toLowerCase().includes(needle) ||
    (choice.name ?? '').toLowerCase().includes(needle)
  );
}

/**
 * Searchable picker over one catalog axis, backed by clack's `autocomplete`
 * prompt: typing filters the list live, which is what makes a large catalog
 * navigable at all — pi alone advertises hundreds of `openrouter/*` models,
 * far past what arrow-keying a plain select can reach.
 *
 * The options getter is re-evaluated by clack on every keystroke with the
 * prompt instance as `this`, so it reads `this.userInput` and does the
 * filtering itself (no clack `filter` is passed, so the rendered list is
 * exactly what the getter returns). When the typed text is not an exact
 * choice id, one dynamic option carrying that text VERBATIM is appended, so
 * an arbitrary custom id submits directly with Enter — a catalog miss is NOT
 * evidence a model is unusable (pi passes unknown ids through as custom
 * model ids), and this replaces the old select-and-then-free-text dance with
 * one keystroke fewer while keeping the same escape hatch.
 */
async function pickSearchableChoice(
  message: string,
  choices: Array<{ id: string; name?: string }>,
  currentValue: string | undefined,
): Promise<string> {
  const picked = await clack.autocomplete<string>({
    message,
    maxItems: SEARCH_MAX_ITEMS,
    placeholder: 'Type to search…',
    ...(currentValue ? { initialValue: currentValue } : {}),
    options() {
      const input = this.userInput.trim();
      const matching = (
        input.length > 0 ? choices.filter((choice) => searchMatchesChoice(input, choice)) : choices
      ).map((choice) => ({ value: choice.id, label: choice.name ?? choice.id }));
      const exact =
        input.length > 0 && choices.some((choice) => choice.id.toLowerCase() === input.toLowerCase());
      const custom =
        input.length > 0 && !exact ? [{ value: input, label: `Use "${input}"`, hint: 'custom id' }] : [];
      return [...matching, ...custom];
    },
  });
  return unwrapPrompt(picked, 'Pairing cancelled.');
}

/**
 * Free-text entry for a model/effort id the catalog does not contain. A
 * catalog miss is NOT evidence a model is unusable — pi (among others)
 * passes unknown ids through verbatim as custom model ids — so the value is
 * taken as given and whatever the harness makes of it surfaces at runtime.
 * Empty input (bare Enter) skips the axis entirely; Ctrl-C still cancels the
 * whole pairing via `unwrapPrompt`.
 */
async function promptCustomValue(
  message: string,
  placeholder: string,
): Promise<string | undefined> {
  // No `validate`: bare Enter must SKIP the axis (that is what the message
  // promises), so emptiness is resolved here rather than re-prompted.
  const picked = await clack.text({ message, placeholder });
  const value = unwrapPrompt(picked, 'Pairing cancelled.').trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Queries the agent's own LIVE catalog (never a hardcoded list); a picker
 * only appears for an axis the agent actually advertises, and each option's
 * current default is pre-selected so pressing enter keeps the harness
 * default. The MODEL axis is a searchable list (`pickSearchableChoice`) and
 * accepts any typed id; the small EFFORT list stays a plain select with an
 * explicit custom-level escape — a value absent from the catalog may still
 * be perfectly usable (harnesses like pi accept unknown ids as custom model
 * ids), so the user is never fenced into the advertised set.
 *
 * A catalog fetch failure is NOT the end of selection either: with manual
 * entry available, both axes fall back to free-text prompts so the user can
 * still proceed deliberately instead of silently launching with the harness
 * default.
 *
 * `flags.model` / `flags.effort` skip that axis's prompt (the matching CLI
 * flag was already given). Passing both returns immediately without fetching
 * the catalog — flag values are validated (warn-only) by the caller.
 */
export async function pickModelAndEffort(
  agent: AgentCommand,
  agentEnv: Record<string, string>,
  flags: { model?: string; effort?: string } = {},
): Promise<{ model?: string; effort?: string }> {
  const selection: { model?: string; effort?: string } = {};
  if (flags.model) selection.model = flags.model;
  if (flags.effort) selection.effort = flags.effort;
  if (selection.model && selection.effort) return selection;

  const spinner = clack.spinner();
  spinner.start(`Reading ${agent.kind}'s available models…`);
  let catalog: AgentModelConfigOption[] | null = null;
  try {
    catalog = (await fetchAgentModelCatalog(agent, agentEnv)).catalog;
    spinner.stop('Catalog loaded.');
  } catch (error) {
    spinner.stop('Could not read the catalog — you can still enter model/effort manually.');
    clack.log.warn(error instanceof Error ? error.message : String(error));
  }

  const modelAxis = catalog?.find((option) => option.category === 'model');
  if (!selection.model) {
    if (modelAxis && modelAxis.options.length > 0) {
      selection.model = await pickSearchableChoice(
        `Model for this ${agent.kind} agent?`,
        modelAxis.options,
        modelAxis.currentValue,
      );
    } else {
      // No usable catalog (fetch failed, or the harness advertised no model
      // axis) — manual entry is the only path, and skipping stays allowed.
      selection.model = await promptCustomValue(
        `Model id for this ${agent.kind} agent? (Enter to skip)`,
        'provider/model-id',
      );
    }
  }

  const effortAxis = catalog?.find((option) =>
    (EFFORT_AXIS_CATEGORIES as readonly string[]).includes(option.category),
  );
  if (!selection.effort) {
    if (effortAxis && effortAxis.options.length > 0) {
      const picked = await clack.select<string>({
        message: `Effort/thinking level for this ${agent.kind} agent?`,
        options: [
          ...effortAxis.options.map((choice) => ({
            value: choice.id,
            label: choice.name ?? choice.id,
          })),
          {
            value: CUSTOM_CHOICE,
            label: 'Enter a custom level…',
            hint: 'any level the list does not show',
          },
        ],
        ...(effortAxis.currentValue ? { initialValue: effortAxis.currentValue } : {}),
      });
      selection.effort =
        picked === CUSTOM_CHOICE
          ? await promptCustomValue(
              `Custom effort/thinking level for this ${agent.kind} agent? (Enter to skip)`,
              'low | medium | high | …',
            )
          : unwrapPrompt(picked, 'Pairing cancelled.');
    } else {
      selection.effort = await promptCustomValue(
        `Effort/thinking level for this ${agent.kind} agent? (Enter to skip)`,
        'low | medium | high | …',
      );
    }
  }

  return selection;
}

/** Who may address this agent — the same choice `--access` sets. */
export async function pickAccessPolicy(): Promise<AgentAccessPolicy> {
  const picked = await clack.select<AgentAccessPolicy>({
    message: 'Who may address this agent?',
    options: [
      { value: 'everyone', label: 'Everyone in the Room' },
      { value: 'creator', label: 'Just me — the inviting owner', hint: 'default' },
    ],
    initialValue: DEFAULT_ACCESS_POLICY,
  });
  return unwrapPrompt(picked, 'Pairing cancelled.');
}

/**
 * Customize the line a non-permitted questioner hears under `creator`
 * access. Pressing enter keeps `DEFAULT_ACCESS_AUTO_RESPONSE`, which is
 * reported back as `undefined` so the caller stores no override and the
 * daemon's own default stays the single source of truth.
 */
export async function pickAutoResponse(): Promise<string | undefined> {
  const picked = await clack.text({
    message: 'Auto-response for a non-permitted questioner? (Enter keeps the default)',
    placeholder: DEFAULT_ACCESS_AUTO_RESPONSE,
    defaultValue: DEFAULT_ACCESS_AUTO_RESPONSE,
  });
  const value = unwrapPrompt(picked, 'Pairing cancelled.');
  return value === DEFAULT_ACCESS_AUTO_RESPONSE ? undefined : value;
}

export interface AccessSettingsInput {
  /** From `--access`; undefined means the flag was omitted. */
  access?: AgentAccessPolicy;
  /** From `--auto-response`; undefined means the flag was omitted. */
  autoResponse?: string;
  interactiveUi: boolean;
}

export interface AccessSettingsPickers {
  pickAccess?: () => Promise<AgentAccessPolicy>;
  pickAutoResponse?: () => Promise<string | undefined>;
}

/**
 * Resolves the access policy + auto-response for one agent being paired.
 * Each flag, when present, skips its prompt outright. The auto-response
 * prompt only ever runs once access has resolved to `creator` — asking for a
 * custom refusal line under `everyone` access has nothing to apply to.
 * Non-interactive sessions (or flags already given) never prompt and fall
 * back to `DEFAULT_ACCESS_POLICY`, matching pre-existing behaviour.
 */
export async function resolveAccessSettings(
  input: AccessSettingsInput,
  pickers: AccessSettingsPickers = {},
): Promise<{ access: AgentAccessPolicy; autoResponse?: string }> {
  const pickAccess = pickers.pickAccess ?? pickAccessPolicy;
  const pickAutoResponseValue = pickers.pickAutoResponse ?? pickAutoResponse;

  let access = input.access;
  if (access === undefined) {
    access = input.interactiveUi ? await pickAccess() : DEFAULT_ACCESS_POLICY;
  }

  let autoResponse = input.autoResponse;
  if (autoResponse === undefined && access === 'creator' && input.interactiveUi) {
    autoResponse = await pickAutoResponseValue();
  }

  return { access, ...(autoResponse !== undefined ? { autoResponse } : {}) };
}
