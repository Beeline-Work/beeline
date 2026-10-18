/** Provider figures only; utilization is a fraction and reset timestamps are Unix seconds. */
export type UsageWindow = {
  rateLimitType: string;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  utilization?: number;
  resetsAt?: number;
  updatedAt: number;
};
export type AgentUsage = {
  updatedAt: number;
  windows: readonly UsageWindow[];
  context?: { used: number; size: number };
  free?: { used: number; limit: number; resetsAt: number };
};

export function readUsageWindow(value: unknown, updatedAt: number): UsageWindow | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (
    typeof v.rateLimitType !== 'string' ||
    !/^[a-z_]{1,64}$/.test(v.rateLimitType) ||
    !['allowed', 'allowed_warning', 'rejected'].includes(String(v.status)) ||
    (v.utilization === undefined
      ? v.status !== 'rejected'
      : typeof v.utilization !== 'number' ||
        !Number.isFinite(v.utilization) ||
        v.utilization < 0) ||
    (v.resetsAt !== undefined &&
      (typeof v.resetsAt !== 'number' || !Number.isFinite(v.resetsAt) || v.resetsAt < 0))
  )
    return;
  return {
    rateLimitType: v.rateLimitType,
    status: v.status as UsageWindow['status'],
    ...(typeof v.utilization === 'number' ? { utilization: v.utilization } : {}),
    ...(typeof v.resetsAt === 'number' ? { resetsAt: v.resetsAt } : {}),
    updatedAt,
  };
}

export function readAgentUsage(value: unknown): AgentUsage | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (
    typeof v.updatedAt !== 'number' ||
    !Number.isFinite(v.updatedAt) ||
    !Array.isArray(v.windows) ||
    v.windows.length > 64
  )
    return;
  const windows: UsageWindow[] = [];
  for (const entry of v.windows) {
    const w = entry as Record<string, unknown>;
    if (!w || typeof w.updatedAt !== 'number' || !Number.isFinite(w.updatedAt)) return;
    const parsed = readUsageWindow(w, w.updatedAt);
    if (!parsed) return;
    windows.push(parsed);
  }
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const c = v.context as Record<string, unknown> | undefined;
  const f = v.free as Record<string, unknown> | undefined;
  if (c && (!finite(c.used) || !finite(c.size) || c.size === 0)) return;
  if (f && (!finite(f.used) || !finite(f.limit) || f.limit === 0 || !finite(f.resetsAt))) return;
  return {
    updatedAt: v.updatedAt,
    windows,
    ...(c ? { context: { used: c.used as number, size: c.size as number } } : {}),
    ...(f
      ? {
          free: {
            used: f.used as number,
            limit: f.limit as number,
            resetsAt: f.resetsAt as number,
          },
        }
      : {}),
  };
}

export const USAGE_WINDOW_LABELS: Record<string, string> = Object.assign(Object.create(null), {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
});
export function usageTokens(n: number): string {
  return n >= 1_000_000
    ? `${Number((n / 1_000_000).toFixed(1))}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}K`
      : String(n);
}
export function usagePrompt(usage?: AgentUsage): string {
  const time = (n: number) =>
    new Date(n * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const reset = (n: number, weekly = false) =>
    `${weekly ? new Date(n * 1000).toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' : ''}${time(n)}`;
  if (usage?.free) {
    const f = usage.free;
    return `Usage: ${usageTokens(f.used)} of ${usageTokens(f.limit)} free tokens today, resets ${time(f.resetsAt)}.`;
  }
  if (!usage?.windows?.length) return 'Usage: unknown (harness reports none).';
  return `Usage: Claude ${usage.windows.map((w) => `${(USAGE_WINDOW_LABELS[w.rateLimitType] ?? w.rateLimitType).toLowerCase()} ${w.utilization === undefined ? '' : `${Math.round(w.utilization * 100)}%`}${w.status === 'rejected' ? ' (limit reached)' : ''}${w.resetsAt ? ` (resets ${reset(w.resetsAt, w.rateLimitType.startsWith('seven_day'))})` : ''}`).join(', ')}, as of ${time(usage.updatedAt)}.`;
}
