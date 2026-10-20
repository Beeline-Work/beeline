/** Provider figures only; utilization is a fraction and reset timestamps are Unix seconds. */
export type UsageWindow = {
  rateLimitType: string;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  utilization?: number;
  resetsAt?: number;
  updatedAt: number;
  /** The provider's own name for a window it reports without a known type. */
  label?: string;
};
/** Spend on the agent's own OpenRouter key, in US dollars, shared by every agent on that key. */
export type UsageSpend = {
  /** Absent when OpenRouter refused a turn before the key's figures could be read. */
  today?: number;
  week?: number;
  /** Key credit limit; absent when the key is unlimited. */
  limit?: number;
  remaining?: number;
  /** The key limit is used up, so OpenRouter refuses this agent's calls. */
  rejected?: boolean;
};
export type AgentUsage = {
  updatedAt: number;
  windows: readonly UsageWindow[];
  context?: { used: number; size: number };
  /** Beeline's free allowance: tokens only, shared by the owner's free agents. */
  free?: { used: number; limit: number; resetsAt: number; paused?: boolean };
  spend?: UsageSpend;
  /** The provider's plan name, as quota-axi reports it. */
  plan?: string;
  /** Prepaid credits left on the plan (Codex). */
  credits?: { remaining: number };
};

/** A provider snapshot this old means the agent has been idle since. */
export const USAGE_OLD_SECONDS = 30 * 60;
export function usageIsOld(usage: AgentUsage, now = Date.now() / 1000): boolean {
  return !usage.free && now - usage.updatedAt >= USAGE_OLD_SECONDS;
}

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
    ...(usageText(v.label) ? { label: usageText(v.label) } : {}),
  };
}


const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
/** A short provider-supplied name, or undefined. */
function usageText(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && text.length <= 40 ? text : undefined;
}

function readSpend(value: unknown): UsageSpend | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if ((s.today !== undefined && !finite(s.today)) || (s.week !== undefined && !finite(s.week))) return null;
  if (s.today === undefined && s.week === undefined && s.rejected !== true) return null;
  if (s.limit !== undefined && (!finite(s.limit) || s.limit === 0)) return null;
  if (s.remaining !== undefined && typeof s.remaining !== 'number') return null;
  if (s.rejected !== undefined && typeof s.rejected !== 'boolean') return null;
  return {
    ...(s.today !== undefined ? { today: s.today as number } : {}),
    ...(s.week !== undefined ? { week: s.week as number } : {}),
    ...(s.limit !== undefined ? { limit: s.limit as number } : {}),
    ...(typeof s.remaining === 'number' && Number.isFinite(s.remaining)
      ? { remaining: Math.max(0, s.remaining) }
      : {}),
    ...(s.rejected ? { rejected: true } : {}),
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
  const c = v.context as Record<string, unknown> | undefined;
  const f = v.free as Record<string, unknown> | undefined;
  if (c && (!finite(c.used) || !finite(c.size) || c.size === 0)) return;
  if (f && (!finite(f.used) || !finite(f.limit) || f.limit === 0 || !finite(f.resetsAt))) return;
  if (f && f.paused !== undefined && typeof f.paused !== 'boolean') return;
  const spend = readSpend(v.spend);
  if (spend === null) return;
  const credits = v.credits as Record<string, unknown> | undefined;
  if (credits !== undefined && (!credits || !finite(credits.remaining))) return;
  const plan = usageText(v.plan);
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
            ...(f.paused ? { paused: true } : {}),
          },
        }
      : {}),
    ...(spend ? { spend } : {}),
    ...(plan ? { plan } : {}),
    ...(credits ? { credits: { remaining: credits.remaining as number } } : {}),
  };
}

export const USAGE_WINDOW_LABELS: Record<string, string> = Object.assign(Object.create(null), {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Opus weekly',
  seven_day_sonnet: 'Sonnet weekly',
  weekly: 'Weekly',
  included_usage: 'Included',
  auto_usage: 'Auto',
  api_usage: 'API',
});
export function usageWindowLabel(rateLimitType: string, label?: string): string {
  const named = label ? label[0]!.toUpperCase() + label.slice(1) : undefined;
  return USAGE_WINDOW_LABELS[rateLimitType] ?? named ?? rateLimitType.replaceAll('_', ' ');
}
export function usageTokens(n: number): string {
  return n >= 1_000_000
    ? `${Number((n / 1_000_000).toFixed(1))}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}K`
      : String(n);
}
/** "$4.12", or "$20" for a whole-dollar limit. */
export function usageDollars(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/**
 * One plain sentence for an agent to relay when its user asks about usage.
 * Free-agent sentences never carry money.
 */
export function usageSummary(usage?: AgentUsage, now = Date.now() / 1000): string {
  const time = (n: number) =>
    new Date(n * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const reset = (n: number) =>
    `${n - now >= 86_400 ? new Date(n * 1000).toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' : ''}${time(n)}`;
  const context = usage?.context
    ? `context ${usageTokens(usage.context.used)} of ${usageTokens(usage.context.size)} tokens`
    : undefined;
  const asOf = (u: AgentUsage) =>
    usageIsOld(u, now)
      ? `as of ${time(u.updatedAt)} (old: the agent has been idle since)`
      : `as of ${time(u.updatedAt)}`;
  if (usage?.free) {
    const f = usage.free;
    return f.paused
      ? `Usage: free tokens paused until ${time(f.resetsAt)}.`
      : `Usage: ${usageTokens(f.used)} of ${usageTokens(f.limit)} free tokens today (shared with your other free agents), resets ${time(f.resetsAt)}.`;
  }
  if (usage?.spend) {
    const s = usage.spend;
    const parts = [
      ...(s.today !== undefined ? [`${usageDollars(s.today)} spent today`] : []),
      ...(s.week !== undefined ? [`${usageDollars(s.week)} this week`] : []),
    ];
    const limit = s.rejected
      ? s.limit
        ? `${usageDollars(s.limit)} key limit reached`
        : 'key limit reached (OpenRouter refused the last call)'
      : s.limit
        ? `${usageDollars(s.remaining ?? 0)} of ${usageDollars(s.limit)} key limit left`
        : undefined;
    return `Usage: ${[`${parts.length ? `${parts.join(', ')} on` : 'on'} the shared OpenRouter key`, ...(limit ? [limit] : []), ...(context ? [context] : [])].join(', ')}, ${asOf(usage)}.`;
  }
  if (usage?.windows.length) {
    const windows = usage.windows.map((w) => {
      const label = usageWindowLabel(w.rateLimitType, w.label).toLowerCase();
      if (w.status === 'rejected')
        return `${label} limit reached${w.resetsAt ? ` (back ${reset(w.resetsAt)})` : ''}`;
      return `${label} ${Math.round((w.utilization ?? 0) * 100)}%${w.resetsAt ? ` (resets ${reset(w.resetsAt)})` : ''}`;
    });
    const credits = usage.credits ? `${Math.floor(usage.credits.remaining).toLocaleString('en-US')} credits left` : undefined;
    return `Usage: ${usage.plan ? `${usage.plan} plan ` : ''}${[...windows, ...(credits ? [credits] : []), ...(context ? [context] : [])].join(', ')}, ${asOf(usage)}.`;
  }
  return `Usage: unknown (harness reports none).${context ? ` Current ${context}.` : ''}`;
}
