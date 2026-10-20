import { describe, expect, it, vi } from 'vitest';
import { parseAcpUsage } from './acp.js';
import { HarnessQuotaReader, quotaAxiArgs, quotaAxiLaunch, quotaAxiProvider, quotaAxiUsage } from './harness-quota.js';
import { QUOTA_AXI_CLAUDE_REPORT, QUOTA_AXI_CODEX_CURSOR_REPORT } from './harness-quota.fixtures.js';

const now = Date.parse('2026-10-20T02:22:23.939Z') / 1000;

describe('quota-axi plan usage (Reproduction R2)', () => {
  it('reads the Codex usage update codex-acp 2.2.2 sent on squire as context only', () => {
    // Recorded from a real codex-acp session: no plan windows in any update or _meta.
    expect(parseAcpUsage({ sessionUpdate: 'usage_update', used: 12967, size: 475000 })).toMatchObject({
      windows: [],
      context: { used: 12967, size: 475000 },
    });
  });

  it('turns the recorded Codex report into a weekly window, plan and credits', () => {
    expect(quotaAxiUsage(QUOTA_AXI_CODEX_CURSOR_REPORT, 'codex', now)).toEqual({
      updatedAt: now,
      windows: [
        {
          rateLimitType: 'weekly',
          status: 'allowed',
          utilization: 0.47,
          resetsAt: Date.parse('2026-10-24T20:43:11.000Z') / 1000,
          updatedAt: now,
          label: 'week',
        },
      ],
      plan: 'pro',
      credits: { remaining: 62174.920478 },
    });
  });

  it('turns the recorded Cursor report into its monthly and weekly windows', () => {
    const usage = quotaAxiUsage(QUOTA_AXI_CODEX_CURSOR_REPORT, 'cursor', now)!;
    expect(usage.plan).toBe('Ultra');
    expect(usage.windows.map((w) => [w.rateLimitType, w.utilization, w.label])).toEqual([
      ['included_usage', 0, 'included usage'],
      ['auto_usage', 0, 'auto usage'],
      ['api_usage', 0, 'API usage'],
      ['grok_bot', 0, 'Grok Bot'],
    ]);
    expect(usage.credits).toBeUndefined();
  });

  it('ignores unknown fields, unusable windows and unavailable providers', () => {
    expect(quotaAxiUsage({ providers: [{ provider: 'grok', state: { status: 'unavailable' }, windows: [] }] }, 'grok', now)).toBeUndefined();
    expect(quotaAxiUsage({ providers: 'x' }, 'codex', now)).toBeUndefined();
    const usage = quotaAxiUsage({
      providers: [{
        provider: 'codex',
        future: true,
        windows: [
          { id: 'model:gpt-6', percentRemaining: 0, resetsAt: 'soon' },
          { id: 'five_hour', percentRemaining: 'half' },
          { percentRemaining: 50 },
        ],
        credits: { remaining: 5, unit: 'usd' },
      }],
    }, 'codex', now)!;
    expect(usage.windows).toEqual([
      { rateLimitType: 'model_gpt', status: 'rejected', utilization: 1, updatedAt: now },
    ]);
    expect(usage.credits).toBeUndefined();
  });

  it('turns the recorded Claude report into session, weekly and Fable windows', () => {
    const usage = quotaAxiUsage(QUOTA_AXI_CLAUDE_REPORT, 'claude', now)!;
    expect(usage.plan).toBe('max');
    expect(usage.windows.map((w) => [w.rateLimitType, w.utilization, w.label])).toEqual([
      ['five_hour', 0.09, 'session'],
      ['seven_day', 0.28, 'week'],
      ['model_fable', 0, 'Fable week'],
    ]);
  });

  it('never opts quota-axi into a credential refresh, keychain prompt or Claude inference', () => {
    expect(quotaAxiArgs('claude')).toEqual(['--provider', 'claude', '--json', '--no-credential-refresh']);
  });

  it('asks quota-axi for every harness it covers and not for OpenRouter keys', () => {
    expect(quotaAxiProvider('codex', false)).toBe('codex');
    expect(quotaAxiProvider('cursor', false)).toBe('cursor');
    expect(quotaAxiProvider('grok', false)).toBe('grok');
    expect(quotaAxiProvider('opencode', false)).toBe('opencode-go');
    expect(quotaAxiProvider('opencode', true)).toBeUndefined();
    expect(quotaAxiProvider('claude', false)).toBe('claude');
    expect(quotaAxiProvider('claude', true)).toBeUndefined();
    expect(quotaAxiProvider('pi', false)).toBeUndefined();
  });

  it('runs the bundled copy beside the Beeline CLI inside a release', () => {
    expect(quotaAxiLaunch('beeline:bundle', '/opt/lib/beeline/beeline-cli.mjs').args).toEqual([
      '/opt/lib/beeline/quota-axi.mjs',
    ]);
    expect(quotaAxiLaunch().args[0]).toMatch(/quota-axi[/\\]dist[/\\]bin[/\\]quota-axi\.js$/);
  });

  it('reads in the agent environment at most once per interval and never throws', async () => {
    let clock = 0;
    const post = vi.fn(async () => undefined);
    const run = vi.fn(async () => JSON.stringify(QUOTA_AXI_CODEX_CURSOR_REPORT));
    const reader = new HarnessQuotaReader({ agentId: 'a', slots: new Map(), post, run, now: () => clock, launch: () => ({ command: 'node', args: ['q.mjs'] }) });
    const env = { CODEX_HOME: '/agent/codex' };
    await reader.publish('codex', env);
    await reader.publish('codex', env);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      { command: 'node', args: ['q.mjs', '--provider', 'codex', '--json', '--no-credential-refresh'] },
      env,
    );
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ plan: 'pro' }));
    clock += 5 * 60_000;
    run.mockRejectedValueOnce(new Error('timeout'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(reader.publish('codex', env)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(1);
    error.mockRestore();
    await reader.publish(undefined, env);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('shares one read per interval across the Room and corner loops of one agent', async () => {
    let clock = 0;
    const slots = new Map();
    const run = vi.fn(async () => JSON.stringify(QUOTA_AXI_CODEX_CURSOR_REPORT));
    const launch = () => ({ command: 'node', args: ['q.mjs'] });
    const reader = (agentId: string) =>
      new HarnessQuotaReader({ agentId, slots, run, launch, now: () => clock, post: async () => undefined });
    const room = reader('agent-a');
    const corner = reader('agent-a');
    const env = { CODEX_HOME: '/agent/codex' };
    // Two loops start reads at the same instant; one reaches the vendor.
    await Promise.all([room.publish('codex', env), corner.publish('codex', env)]);
    expect(run).toHaveBeenCalledTimes(1);
    clock += 60_000;
    await corner.publish('codex', env);
    expect(run).toHaveBeenCalledTimes(1);
    // Another agent keeps its own budget.
    await reader('agent-b').publish('codex', env);
    expect(run).toHaveBeenCalledTimes(2);
    clock += 5 * 60_000;
    await corner.publish('codex', env);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
