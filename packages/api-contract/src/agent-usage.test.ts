import { describe, expect, it } from 'vitest';
import { readAgentUsage, usageIsOld, usageSummary } from './agent-usage.js';

const now = 1_800_000_000;

describe('usage projection', () => {
  it('tolerates absent reports and rejects invalid provider figures', () => {
    expect(readAgentUsage(undefined)).toBeUndefined();
    expect(readAgentUsage({ updatedAt: 1, windows: [{ rateLimitType: 'five_hour', updatedAt: 1, status: 'allowed', utilization: Infinity }] })).toBeUndefined();
    expect(readAgentUsage({ updatedAt: 1, windows: [], spend: { today: -1, week: 2 } })).toBeUndefined();
    expect(usageSummary()).toBe('Usage: unknown (harness reports none).');
  });
  it('treats unknown window names as data rather than object properties', () => {
    const usage = readAgentUsage({ updatedAt: now, windows: [{ rateLimitType: 'constructor', updatedAt: now, status: 'allowed', utilization: 0.42 }] });
    expect(usageSummary(usage, now)).toContain('constructor 42%');
  });
  it('summarises Claude windows with resets, context and staleness', () => {
    const usage = readAgentUsage({
      updatedAt: now - 1900,
      windows: [
        { rateLimitType: 'five_hour', updatedAt: now, status: 'rejected', resetsAt: now + 600 },
        { rateLimitType: 'seven_day', updatedAt: now, status: 'allowed', utilization: 0.83, resetsAt: now + 86_400 * 3 },
      ],
      context: { used: 612_000, size: 1_000_000 },
    })!;
    const text = usageSummary(usage, now);
    expect(text).toMatch(/^Usage: 5-hour limit reached \(back \d\d:\d\d\), weekly 83% \(resets \w{3} \d\d:\d\d\), context 612K of 1M tokens, as of \d\d:\d\d \(old/);
    expect(usageIsOld(usage, now)).toBe(true);
  });
  it('keeps money out of free-agent results, including the paused state', () => {
    const free = readAgentUsage({ updatedAt: now, windows: [], free: { used: 840_000, limit: 1_000_000, resetsAt: now + 3600 } })!;
    const paused = readAgentUsage({ updatedAt: now, windows: [], free: { used: 1, limit: 1_000_000, resetsAt: now + 3600, paused: true } })!;
    expect(usageSummary(free, now)).toMatch(/^Usage: 840K of 1M free tokens today \(shared with your other free agents\), resets \d\d:\d\d\.$/);
    expect(usageSummary(paused, now)).toMatch(/^Usage: free tokens paused until \d\d:\d\d\.$/);
    expect(usageSummary(free, now)).not.toContain('$');
    expect(usageSummary(paused, now)).not.toContain('$');
    expect(usageIsOld({ ...free, updatedAt: 0 }, now)).toBe(false);
  });
  it('reports shared OpenRouter key spend with and without a key limit', () => {
    const limited = readAgentUsage({ updatedAt: now, windows: [], spend: { today: 4.12, week: 18.4, limit: 20, remaining: 15.88 } })!;
    const open = readAgentUsage({ updatedAt: now, windows: [], spend: { today: 4.12, week: 18.4 } })!;
    const reached = readAgentUsage({ updatedAt: now, windows: [], spend: { today: 11.2, week: 20, limit: 20, remaining: 0, rejected: true } })!;
    expect(usageSummary(limited, now)).toMatch(/^Usage: \$4\.12 spent today, \$18\.40 this week on the shared OpenRouter key, \$15\.88 of \$20 key limit left, as of \d\d:\d\d\.$/);
    expect(usageSummary(open, now)).not.toContain('key limit');
    expect(usageSummary(reached, now)).toContain('$20 key limit reached');
    const refused = readAgentUsage({ updatedAt: now, windows: [], spend: { rejected: true } })!;
    expect(usageSummary(refused, now)).toMatch(/^Usage: on the shared OpenRouter key, key limit reached \(OpenRouter refused the last call\), as of/);
    expect(readAgentUsage({ updatedAt: now, windows: [], spend: {} })).toBeUndefined();
  });
  it('keeps a plan, credits left and provider window labels', () => {
    const usage = readAgentUsage({
      updatedAt: now,
      windows: [{ rateLimitType: 'grok_bot', label: 'Grok Bot', updatedAt: now, status: 'allowed', utilization: 0.1 }],
      plan: 'pro',
      credits: { remaining: 62174.92 },
    })!;
    expect(usage).toMatchObject({ plan: 'pro', credits: { remaining: 62174.92 } });
    expect(usage.windows[0]!.label).toBe('Grok Bot');
    expect(usageSummary(usage, now)).toMatch(/^Usage: pro plan grok bot 10%.*, 62,174 credits left, as of/);
    expect(readAgentUsage({ updatedAt: now, windows: [], credits: { remaining: -1 } })).toBeUndefined();
  });
});
