import { describe, expect, it, vi } from 'vitest';
import { parseAcpUsage } from './acp.js';
import { HarnessQuotaReader, quotaAxiArgs, quotaAxiLaunch, quotaAxiProvider, quotaAxiUsage } from './harness-quota.js';
import { QUOTA_AXI_CLAUDE_REPORT, QUOTA_AXI_CODEX_CURSOR_REPORT } from '../../../tests/helpers/helper.js';

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
      read: { status: 'fresh', at: now },
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
    expect(quotaAxiUsage({ providers: [{ provider: 'grok', state: { status: 'unavailable' }, windows: [] }] }, 'grok', now)).toEqual({
      updatedAt: now, windows: [], read: { status: 'failed', at: now, reason: 'unavailable' },
    });
    expect(quotaAxiUsage({ providers: [{ provider: 'grok', state: { status: 'fresh' }, windows: [] }] }, 'grok', now)).toBeUndefined();
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
    expect(quotaAxiArgs('claude')).toEqual(['--provider', 'claude', '--json', '--full', '--no-credential-refresh']);
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
      { command: 'node', args: ['q.mjs', '--provider', 'codex', '--json', '--full', '--no-credential-refresh'] },
      env,
    );
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ plan: 'pro' }));
    clock += 5 * 60_000;
    run.mockRejectedValueOnce(new Error('timeout'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(reader.publish('codex', env)).resolves.toEqual({ status: 'failed', reason: "usage reader didn't run" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ windows: [], read: expect.objectContaining({ status: 'failed' }) }));
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
    // Another agent on the same login shares the read; another login keeps its own budget.
    await reader('agent-b').publish('codex', env);
    expect(run).toHaveBeenCalledTimes(1);
    await reader('agent-c').publish('codex', { CODEX_HOME: '/other/codex' });
    expect(run).toHaveBeenCalledTimes(2);
    clock += 5 * 60_000;
    await corner.publish('codex', env);
    expect(run).toHaveBeenCalledTimes(3);
  });
});


it('an explicit refresh bypasses the automatic interval and posts a new snapshot', async () => {
  let clock = 0;
  const run = vi.fn(async () => JSON.stringify(QUOTA_AXI_CODEX_CURSOR_REPORT));
  const post = vi.fn(async () => undefined);
  const reader = new HarnessQuotaReader({ agentId: 'manual', slots: new Map(), run, post, now: () => clock, launch: () => ({ command: 'node', args: [] }) });
  const env = { CODEX_HOME: '/agent/codex' };
  await reader.publish('codex', env);
  await reader.publish('codex', env);
  // A refresh straight after a read shares it rather than asking the vendor again.
  await expect(reader.publish('codex', env, true)).resolves.toEqual({ status: 'fresh' });
  expect(run).toHaveBeenCalledTimes(1);
  clock += 30_000;
  await reader.publish('codex', env, true);
  expect(run).toHaveBeenCalledTimes(2);
  expect(post).toHaveBeenCalledTimes(2);
});

import { describe as m18_describe, expect as m18_expect, it as m18_it, vi as m18_vi } from 'vitest';

import type { AgentUsage as m18_AgentUsage } from '@beeline/api-contract/daemon';

import { HarnessQuotaReader as m18_HarnessQuotaReader, QUOTA_READ_INTERVAL_MS as m18_QUOTA_READ_INTERVAL_MS, quotaAxiUsage as m18_quotaAxiUsage } from "./harness-quota.js";

import { QUOTA_AXI_CLAUDE_REPORT as m18_QUOTA_AXI_CLAUDE_REPORT } from "../../../tests/helpers/helper.js";
import { describe as mergedDescribe18 } from 'vitest';
mergedDescribe18("harness-quota.usage-truth.test.ts", () => {


const now = Date.parse('2026-10-28T14:00:00.000Z') / 1000;

const threeHoursAgo = new Date((now - 3 * 3600) * 1000).toISOString();

const claude = m18_QUOTA_AXI_CLAUDE_REPORT.providers[0]!;

const launch = () => ({ command: 'node', args: ['q.mjs'] });

/** A Claude report as `--full --json` prints it, with a verified account. */
const verified = (accountId: string, state: Record<string, unknown> = { status: 'fresh', stale: false }) => ({
  ...m18_QUOTA_AXI_CLAUDE_REPORT,
  providers: [{ ...claude, account: { accountId, organization: 'org-1', identityStatus: 'verified' }, state }],
});


m18_describe('R-USAGE-3: a stale quota-axi report keeps its read time and status', () => {
  m18_it('stamps the windows with refreshedAt, not now, and carries the stale reason', () => {
    const usage = m18_quotaAxiUsage({
      providers: [{ ...claude, state: { status: 'stale', stale: true, refreshedAt: threeHoursAgo, error: 'fetch failed' } }],
    }, 'claude', now)!;
    m18_expect(usage.updatedAt).toBe(now - 3 * 3600);
    m18_expect(usage.windows.every((w) => w.updatedAt === now - 3 * 3600)).toBe(true);
    m18_expect(usage.read).toEqual({ status: 'stale', at: now, reason: 'fetch failed' });
  });

  m18_it('stamps a stale credit-only Codex read with refreshedAt and keeps its balance', () => {
    const usage = m18_quotaAxiUsage({
      providers: [{
        provider: 'codex', windows: [], credits: { unit: 'credits', remaining: 123 },
        state: { status: 'stale', stale: true, refreshedAt: threeHoursAgo, error: 'network failed' },
      }],
    }, 'codex', now)!;
    m18_expect(usage).toMatchObject({ updatedAt: now - 3 * 3600, windows: [], credits: { remaining: 123 } });
    m18_expect(usage.read).toEqual({ status: 'stale', at: now, reason: 'network failed' });
  });

  m18_it('names an expired sign-in and a rate limit with its retry time', () => {
    const expired = m18_quotaAxiUsage({
      providers: [{ ...claude, state: { status: 'stale', stale: true, refreshedAt: threeHoursAgo, reason: 'credentials_expired' } }],
    }, 'claude', now)!;
    m18_expect(expired.read?.status).toBe('signed_out');
    const limited = m18_quotaAxiUsage({
      providers: [{ ...claude, windows: [], state: { status: 'rate_limited', stale: false, retryAfter: '2026-10-28T14:20:00.000Z' } }],
    }, 'claude', now)!;
    m18_expect(limited.read).toEqual({ status: 'rate_limited', at: now, retryAfter: now + 20 * 60 });
    m18_expect(limited.windows).toEqual([]);
  });
});


m18_describe('one read per plan account on this machine', () => {
  m18_it('lets a second agent on the same login join the read in flight and get its own copy', async () => {
    let finish!: (stdout: string) => void;
    const run = m18_vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const posts: Array<[string, m18_AgentUsage]> = [];
    const slots = new Map();
    const reader = (agentId: string) => new m18_HarnessQuotaReader({
      agentId, slots, run, launch, now: () => now * 1000,
      post: async (usage) => { posts.push([agentId, usage]); },
      credentialPath: () => '/home/op/.claude/.credentials.json',
    });
    const first = reader('ruby').publish('claude', { CLAUDE_CONFIG_DIR: '/agents/ruby/claude' }, true);
    const second = reader('nerd').publish('claude', { CLAUDE_CONFIG_DIR: '/agents/nerd/claude' }, true);
    finish(JSON.stringify(verified('acct-1')));
    await m18_expect(first).resolves.toEqual({ status: 'fresh' });
    await m18_expect(second).resolves.toEqual({ status: 'fresh' });
    m18_expect(run).toHaveBeenCalledTimes(1);
    m18_expect(posts.map(([agent]) => agent).sort()).toEqual(['nerd', 'ruby']);
    m18_expect(posts[0]![1]).toEqual(posts[1]![1]);
    m18_expect(posts[0]![1].account).toEqual({ provider: 'claude', key: m18_expect.stringMatching(/^id:[0-9a-f]{32}$/) });
  });

  m18_it("gives an agent throttled behind a sibling that sibling's read, once, without a vendor call", async () => {
    let clock = now * 1000;
    const run = m18_vi.fn(async () => JSON.stringify(verified('acct-1')));
    const posts: string[] = [];
    const slots = new Map();
    const reader = (agentId: string) => new m18_HarnessQuotaReader({
      agentId, slots, run, launch, now: () => clock,
      post: async () => { posts.push(agentId); },
      credentialPath: () => '/home/op/.claude/.credentials.json',
    });
    await reader('ruby').publish('claude', {});
    clock += 60_000;
    await m18_expect(reader('nerd').publish('claude', {})).resolves.toEqual({ status: 'fresh' });
    await reader('nerd').publish('claude', {});
    m18_expect(run).toHaveBeenCalledTimes(1);
    m18_expect(posts).toEqual(['ruby', 'nerd']);
  });

  m18_it('keys the account by the verified id, never the email, and keeps it for a later stale read', async () => {
    const slots = new Map();
    const posts: m18_AgentUsage[] = [];
    const run = m18_vi.fn(async () => JSON.stringify(verified('acct-1')));
    const reader = new m18_HarnessQuotaReader({
      agentId: 'ruby', slots, run, launch, now: () => now * 1000,
      post: async (usage) => { posts.push(usage); },
      credentialPath: () => '/home/op/.claude/.credentials.json',
    });
    await reader.publish('claude', {}, true);
    run.mockResolvedValueOnce(JSON.stringify({
      providers: [{ ...claude, state: { status: 'stale', stale: true, refreshedAt: threeHoursAgo, reason: 'credentials_expired' } }],
    }));
    const later = new m18_HarnessQuotaReader({
      agentId: 'ruby', slots, run, launch, now: () => (now + 3600) * 1000,
      post: async (usage) => { posts.push(usage); },
      credentialPath: () => '/home/op/.claude/.credentials.json',
    });
    await m18_expect(later.publish('claude', {}, true)).resolves.toEqual({ status: 'signed_out' });
    m18_expect(posts[1]!.account).toEqual(posts[0]!.account);
    m18_expect(JSON.stringify(posts)).not.toContain('acct-1');
  });

  m18_describe('agents with their own copy of one login', () => {
    const setup = (accountOf: Record<string, string>) => {
      let clock = now * 1000;
      const slots = new Map();
      const posts: Array<[string, m18_AgentUsage]> = [];
      const logins: Record<string, string> = {};
      const run = m18_vi.fn(async (_launch: unknown, env: Record<string, string>) =>
        JSON.stringify(verified(accountOf[env.CLAUDE_CONFIG_DIR!]!)));
      const publish = (agentId: string, force = false) => new m18_HarnessQuotaReader({
        agentId, slots, run, launch, now: () => clock,
        post: async (usage) => { posts.push([agentId, usage]); },
        credentialPath: (_provider, env) => `${env.CLAUDE_CONFIG_DIR}/.credentials.json`,
        fingerprint: (path) => logins[path] ?? 'first login',
      }).publish('claude', { CLAUDE_CONFIG_DIR: `/agents/${agentId}/claude` }, force);
      /** `claude /login` to another account in one agent's home. */
      const switchLogin = (agentId: string, accountId: string) => {
        accountOf[`/agents/${agentId}/claude`] = accountId;
        logins[`/agents/${agentId}/claude/.credentials.json`] = `login ${accountId}`;
      };
      return { run, posts, publish, switchLogin, accountOf, advance: (ms: number) => { clock += ms; } };
    };

    m18_it('share one read per interval once quota-axi verifies the account', async () => {
      const { run, posts, publish, advance } = setup({ '/agents/ruby/claude': 'acct-1', '/agents/nerd/claude': 'acct-1' });
      await publish('ruby');
      await publish('nerd');
      advance(m18_QUOTA_READ_INTERVAL_MS + 1);
      await publish('ruby');
      await m18_expect(publish('nerd')).resolves.toEqual({ status: 'fresh' });
      m18_expect(run).toHaveBeenCalledTimes(3);
      const [ruby, nerd] = posts.slice(2);
      m18_expect([ruby![0], nerd![0]]).toEqual(['ruby', 'nerd']);
      m18_expect(nerd![1]).toEqual(ruby![1]);
    });

    m18_it('join a read in flight from another home on the account', async () => {
      const { run, posts, publish, advance } = setup({ '/agents/ruby/claude': 'acct-1', '/agents/nerd/claude': 'acct-1' });
      await publish('ruby');
      await publish('nerd');
      advance(m18_QUOTA_READ_INTERVAL_MS + 1);
      let finish!: (stdout: string) => void;
      run.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
      const ruby = publish('ruby');
      const nerd = publish('nerd');
      finish(JSON.stringify(verified('acct-1')));
      await m18_expect(Promise.all([ruby, nerd])).resolves.toEqual([{ status: 'fresh' }, { status: 'fresh' }]);
      m18_expect(run).toHaveBeenCalledTimes(3);
      m18_expect(posts.slice(2).map(([agent]) => agent).sort()).toEqual(['nerd', 'ruby']);
    });

    m18_it('keep reading separately when the accounts differ', async () => {
      const { run, posts, publish, advance } = setup({ '/agents/ruby/claude': 'acct-1', '/agents/nerd/claude': 'acct-2' });
      await publish('ruby');
      await publish('nerd');
      advance(m18_QUOTA_READ_INTERVAL_MS + 1);
      await publish('ruby');
      await publish('nerd');
      m18_expect(run).toHaveBeenCalledTimes(4);
      m18_expect(posts[3]![1].account).toEqual(posts[1]![1].account);
      m18_expect(posts[3]![1].account).not.toEqual(posts[2]![1].account);
    });

    m18_it('read their own login again as soon as its credential file changes', async () => {
      const { run, posts, publish, switchLogin, advance } = setup({ '/agents/ruby/claude': 'acct-1', '/agents/nerd/claude': 'acct-1' });
      await publish('ruby');
      await publish('nerd');
      switchLogin('nerd', 'acct-2');
      advance(m18_QUOTA_READ_INTERVAL_MS + 1);
      await publish('ruby');
      await publish('nerd');
      m18_expect(run).toHaveBeenCalledTimes(4);
      const [ruby, nerd] = posts.slice(2);
      m18_expect(nerd![0]).toBe('nerd');
      m18_expect(nerd![1].account).not.toEqual(ruby![1].account);
      // Ruby no longer rides Nerd's reads, and Nerd no longer rides Ruby's.
      advance(m18_QUOTA_READ_INTERVAL_MS + 1);
      await publish('ruby');
      await publish('nerd');
      m18_expect(run).toHaveBeenCalledTimes(6);
    });

    m18_it('read and post the new login on a refresh right after the credential file changes', async () => {
      const { run, posts, publish, switchLogin, advance } = setup({ '/agents/nerd/claude': 'acct-1' });
      await publish('nerd', true);
      const before = posts.at(-1)![1];
      run.mockImplementationOnce(async () => {
        const report = verified('acct-2');
        const [provider] = report.providers;
        return JSON.stringify({
          ...report,
          providers: [{ ...provider!, windows: provider!.windows.map((w) => ({ ...w, percentRemaining: 20 })) }],
        });
      });
      switchLogin('nerd', 'acct-2');
      advance(1_000);
      await m18_expect(publish('nerd', true)).resolves.toEqual({ status: 'fresh' });
      m18_expect(run).toHaveBeenCalledTimes(2);
      m18_expect(posts).toHaveLength(2);
      const after = posts[1]![1];
      m18_expect(after.account).not.toEqual(before.account);
      m18_expect(before.windows[0]!.utilization).toBeCloseTo(0.09);
      m18_expect(after.windows.every((w) => Math.abs(w.utilization - 0.8) < 1e-9)).toBe(true);
    });

    m18_it('read their own login on a refresh, even when the file did not change', async () => {
      const { run, posts, publish, accountOf, advance } = setup({ '/agents/ruby/claude': 'acct-1', '/agents/nerd/claude': 'acct-1' });
      await publish('ruby');
      await publish('nerd');
      accountOf['/agents/nerd/claude'] = 'acct-2';
      for (let round = 0; round < 3; round++) {
        advance(m18_QUOTA_READ_INTERVAL_MS + 1);
        await publish('ruby', true);
        await publish('nerd', true);
      }
      const nerd = posts.filter(([agent]) => agent === 'nerd').at(-1)![1];
      const ruby = posts.filter(([agent]) => agent === 'ruby').at(-1)![1];
      m18_expect(nerd.account).not.toEqual(ruby.account);
      m18_expect(run).toHaveBeenCalledTimes(8);
    });

    m18_it('read their own login again within a few intervals between turns', async () => {
      const { run, posts, publish, accountOf, advance } = setup({ '/agents/ruby/claude': 'acct-1', '/agents/nerd/claude': 'acct-1' });
      await publish('ruby');
      await publish('nerd');
      accountOf['/agents/nerd/claude'] = 'acct-2';
      for (let round = 0; round < 3; round++) {
        advance(m18_QUOTA_READ_INTERVAL_MS + 1);
        await publish('ruby');
        await publish('nerd');
      }
      // Nerd rode Ruby's reads for two intervals, then read its own login.
      m18_expect(run).toHaveBeenCalledTimes(6);
      const nerd = posts.filter(([agent]) => agent === 'nerd').at(-1)![1];
      m18_expect(nerd.account).not.toEqual(posts.filter(([agent]) => agent === 'ruby').at(-1)![1].account);
    });

    m18_it("never hand one home's expired sign-in to another home", async () => {
      const { run, posts, publish, advance } = setup({ '/agents/ruby/claude': 'acct-1', '/agents/nerd/claude': 'acct-1' });
      await publish('ruby');
      await publish('nerd');
      advance(m18_QUOTA_READ_INTERVAL_MS + 1);
      run.mockResolvedValueOnce(JSON.stringify(verified('acct-1', { status: 'auth_required', stale: true })));
      await m18_expect(publish('ruby')).resolves.toEqual({ status: 'signed_out' });
      await m18_expect(publish('nerd')).resolves.toEqual({ status: 'fresh' });
      m18_expect(run).toHaveBeenCalledTimes(4);
      m18_expect(posts[3]![0]).toBe('nerd');
    });
  });

  m18_it('answers a failed read with a reason instead of dropping it', async () => {
    const error = m18_vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const posts: m18_AgentUsage[] = [];
    const reader = new m18_HarnessQuotaReader({
      agentId: 'ruby', slots: new Map(), launch, now: () => now * 1000,
      run: async () => { throw new Error('spawn failed'); },
      post: async (usage) => { posts.push(usage); },
      credentialPath: () => '/home/op/.claude/.credentials.json',
    });
    await m18_expect(reader.publish('claude', {}, true)).resolves.toEqual({ status: 'failed', reason: "usage reader didn't run" });
    m18_expect(posts[0]).toMatchObject({ windows: [], read: { status: 'failed' }, account: { provider: 'claude' } });
    m18_expect(posts[0]!.account!.key).toMatch(/^local:[0-9a-f]{32}$/);
    error.mockRestore();
  });
});
});
