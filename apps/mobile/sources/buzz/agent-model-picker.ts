import type { AgentModelConfigOption } from '@beeline/buzz-client';

/** The most option rows an open model/effort list shows before it scrolls. */
export const AGENT_MODEL_PICKER_VISIBLE_ROWS = 5;

/**
 * Case-insensitive live filter for the advertised model catalog. Every
 * whitespace-separated token must be a substring of either the stable model
 * ID or the harness-provided label, so "open 4" finds "OpenAI GPT-4".
 */
export function filterAgentModelOptions(
  options: readonly Pick<AgentModelConfigOption['options'][number], 'id' | 'name'>[],
  query: string,
): Array<Pick<AgentModelConfigOption['options'][number], 'id' | 'name'>> {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [...options];
  return options.filter((option) => {
    const haystack = [option.id, option.name].filter(Boolean).join('\n').toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

const EFFORT_CATEGORIES = ['thought_level', 'effort', 'reasoning_effort'];

/**
 * The harness's Fast mode axis, only when it offers both `on` and `off`. It is
 * the one `model_config` axis the picker may read or write.
 */
export function fastModeConfigAxis<
  T extends Pick<AgentModelConfigOption, 'id' | 'category' | 'options'>,
>(catalog: readonly T[]): T | undefined {
  return catalog.find(
    (axis) =>
      axis.id === 'fast-mode' &&
      axis.category === 'model_config' &&
      axis.options.some((choice) => choice.id === 'on') &&
      axis.options.some((choice) => choice.id === 'off'),
  );
}

/**
 * The effort axis: a known effort category first; otherwise the first axis
 * that is neither the model nor Fast mode, so a harness naming its effort
 * category differently keeps its effort picker.
 */
export function effortConfigAxis<T extends Pick<AgentModelConfigOption, 'id' | 'category'>>(
  catalog: readonly T[],
): T | undefined {
  return (
    catalog.find((axis) => EFFORT_CATEGORIES.includes(axis.category)) ??
    catalog.find(
      (axis) =>
        axis.category !== 'model' && !(axis.id === 'fast-mode' && axis.category === 'model_config'),
    )
  );
}
