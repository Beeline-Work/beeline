export function usageTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  const today = new Date();
  return date.toLocaleString(undefined, {
    ...(date.toDateString() !== today.toDateString() ? { weekday: 'short' as const } : {}),
    hour: 'numeric',
    minute: '2-digit',
  });
}
export function usageHarness(harness?: string): string {
  return harness === 'claude' || harness === 'claude-code'
    ? 'Claude Code'
    : harness === 'codex'
      ? 'Codex'
      : (harness ?? 'Harness');
}
