import type { AgentModelConfigOption } from '@beeline/buzz-client';

/** The most option rows an open model/effort list shows before it scrolls. */
export const AGENT_MODEL_PICKER_VISIBLE_ROWS = 5;

const HARNESS_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  goose: 'Goose',
  grok: 'Grok',
  opencode: 'OpenCode',
  pi: 'Pi',
};

/**
 * The runtime name the Model row shows beside its label, so a catalog reads as
 * that harness's own list (a Cursor agent offers GPT models as well as
 * Claude). `kind` is the helper-reported harness; an unlisted one is shown
 * capitalised rather than hidden.
 */
export function agentHarnessName(kind: string | undefined): string | undefined {
  if (!kind) return undefined;
  return HARNESS_NAMES[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

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
