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
