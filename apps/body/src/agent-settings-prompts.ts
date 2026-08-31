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
import { clackPromptOutput, unwrapPrompt } from './clack-support.js';
import { fetchAgentModelCatalog } from './model-catalog.js';
import { isGrokAgentCommand } from './model-config.js';

export const EFFORT_AXIS_CATEGORIES = ['thought_level', 'effort', 'reasoning_effort'] as const;

/**
 * How many filtered choices the searchable model list shows at once before
 * clack's internal scrolling kicks in.
 */
const SEARCH_MAX_ITEMS = 12;

/** Case-insensitive substring match across a choice's id AND display name. */
function searchMatchesChoice(input: string, choice: { id: string; name?: string }): boolean {
  const needle = input.trim().toLowerCase();
  return (
    choice.id.toLowerCase().includes(needle) || (choice.name ?? '').toLowerCase().includes(needle)
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
 * exactly what the getter returns). The submitted value can only be one of
 * the live catalog entries; typed text narrows the choices but never becomes
 * an arbitrary identifier of its own.
 */
async function pickSearchableChoice(
  message: string,
  choices: Array<{ id: string; name?: string }>,
  currentValue: string | undefined,
): Promise<string> {
  const output = clackPromptOutput();
  const picked = await clack.autocomplete<string>({
    message,
    output,
    maxItems: SEARCH_MAX_ITEMS,
    placeholder: 'Type to search…',
    ...(currentValue ? { initialValue: currentValue } : {}),
    options() {
      const input = this.userInput.trim();
      const matching = (
        input.length > 0 ? choices.filter((choice) => searchMatchesChoice(input, choice)) : choices
      ).map((choice) => ({ value: choice.id, label: choice.name ?? choice.id }));
      return matching;
    },
  });
  return unwrapPrompt(picked, 'Pairing cancelled.');
}

/**
 * Queries the agent's own LIVE catalog (never a hardcoded list); a picker
 * only appears for an axis the agent actually advertises, and each option's
 * current default is pre-selected so pressing enter keeps the harness
 * default. The MODEL axis is searchable and the small EFFORT list remains a
 * plain select. Both are closed over the live values the harness advertised.
 * A catalog read failure aborts selection because accepting unverified text
 * would recreate the retired-model failure this boundary exists to prevent.
 *
 * `flags.model` / `flags.effort` skip that axis's prompt (the matching CLI
 * flag was already given). Passing both returns immediately without fetching
 * the catalog — flag values are strictly validated by the caller.
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

  const output = clackPromptOutput();
  const spinner = clack.spinner({ output });
  spinner.start(`Reading ${agent.kind}'s available models…`);
  let catalog: AgentModelConfigOption[];
  try {
    catalog = (
      await fetchAgentModelCatalog(
        agent,
        agentEnv,
        isGrokAgentCommand(agent) && selection.model ? { model: selection.model } : undefined,
      )
    ).catalog;
    spinner.stop('Catalog loaded.');
  } catch (error) {
    spinner.stop('Could not read the live model catalog.');
    throw error;
  }

  const modelAxis = catalog?.find((option) => option.category === 'model');
  if (!selection.model) {
    if (modelAxis && modelAxis.options.length > 0) {
      selection.model = await pickSearchableChoice(
        `Model for this ${agent.kind} agent?`,
        modelAxis.options,
        modelAxis.currentValue,
      );
      if (isGrokAgentCommand(agent) && !selection.effort) {
        spinner.start(`Reading ${selection.model}'s effort levels…`);
        try {
          catalog = (await fetchAgentModelCatalog(agent, agentEnv, { model: selection.model }))
            .catalog;
          spinner.stop('Effort levels loaded.');
        } catch (error) {
          spinner.stop('Could not read the selected model effort levels.');
          throw error;
        }
      }
    }
  }

  const effortAxis = catalog?.find((option) =>
    (EFFORT_AXIS_CATEGORIES as readonly string[]).includes(option.category),
  );
  if (!selection.effort) {
    if (effortAxis && effortAxis.options.length > 0) {
      const picked = await clack.select<string>({
        message: `Effort/thinking level for this ${agent.kind} agent?`,
        output,
        options: effortAxis.options.map((choice) => ({
          value: choice.id,
          label: choice.name ?? choice.id,
        })),
        ...(effortAxis.currentValue ? { initialValue: effortAxis.currentValue } : {}),
      });
      selection.effort = unwrapPrompt(picked, 'Pairing cancelled.');
    }
  }

  return selection;
}

/** Who may address this agent — the same choice `--access` sets. */
export async function pickAccessPolicy(): Promise<AgentAccessPolicy> {
  const picked = await clack.select<AgentAccessPolicy>({
    message: 'Who may address this agent?',
    output: clackPromptOutput(),
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
    output: clackPromptOutput(),
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
