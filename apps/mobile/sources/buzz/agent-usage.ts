export function usageTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  const today = new Date();
  return date.toLocaleString(undefined, {
    ...(date.toDateString() !== today.toDateString() ? { weekday: 'short' as const } : {}),
    hour: 'numeric',
    minute: '2-digit',
  });
}
const HARNESS_NAMES: Record<string, string> = Object.assign(Object.create(null), {
  claude: 'Claude Code',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  goose: 'Goose',
  opencode: 'OpenCode',
  grok: 'Grok',
  cursor: 'Cursor',
});
export function usageHarness(harness?: string): string {
  return (harness && HARNESS_NAMES[harness]) ?? harness ?? 'This harness';
}
const PROVIDER_NAMES: Record<string, string> = Object.assign(Object.create(null), {
  claude: 'Claude',
  'claude-code': 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  grok: 'Grok',
  opencode: 'OpenCode Go',
});
/** The account a refresh reads: the plan provider, or OpenRouter for key spend. */
export function usageProvider(harness: string | undefined, spend: boolean): string {
  return spend ? 'OpenRouter' : ((harness && PROVIDER_NAMES[harness]) ?? usageHarness(harness));
}
