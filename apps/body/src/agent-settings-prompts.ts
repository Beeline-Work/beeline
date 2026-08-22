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

/** Sentinel option value that switches the picker to a free-text model/effort id. */
const CUSTOM_CHOICE = '__beeline-custom__';

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
 * default. Every picker also carries an explicit custom-id escape — a model
 * absent from the catalog may still be perfectly usable (harnesses like pi
 * accept unknown ids as custom model ids), so the user can type any id.
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
      const picked = await clack.select<string>({
        message: `Model for this ${agent.kind} agent?`,
        options: [
          ...modelAxis.options.map((choice) => ({
            value: choice.id,
            label: choice.name ?? choice.id,
          })),
          {
            value: CUSTOM_CHOICE,
            label: 'Enter a custom model id…',
            hint: 'any id the list does not show',
          },
        ],
        ...(modelAxis.currentValue ? { initialValue: modelAxis.currentValue } : {}),
      });
      selection.model =
        picked === CUSTOM_CHOICE
          ? await promptCustomValue(
              `Custom model id for this ${agent.kind} agent? (Enter to skip)`,
              'provider/model-id',
            )
          : unwrapPrompt(picked, 'Pairing cancelled.');
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
