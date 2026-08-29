import type { AgentModelConfigOption } from '@beeline/buzz-client';

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
