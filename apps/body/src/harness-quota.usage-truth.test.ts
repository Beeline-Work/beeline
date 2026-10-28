import { describe, expect, it, vi } from 'vitest';
import type { AgentUsage } from '@beeline/api-contract/daemon';
import { HarnessQuotaReader, quotaAxiUsage } from './harness-quota.js';
import { QUOTA_AXI_CLAUDE_REPORT } from './harness-quota.fixtures.js';

const now = Date.parse('2026-10-28T14:00:00.000Z') / 1000;
const threeHoursAgo = new Date((now - 3 * 3600) * 1000).toISOString();
const claude = QUOTA_AXI_CLAUDE_REPORT.providers[0]!;
const launch = () => ({ command: 'node', args: ['q.mjs'] });
/** A Claude report as `--full --json` prints it, with a verified account. */
const verified = (accountId: string, state: Record<string, unknown> = { status: 'fresh', stale: false }) => ({
  ...QUOTA_AXI_CLAUDE_REPORT,
  providers: [{ ...claude, account: { accountId, organization: 'org-1', identityStatus: 'verified' }, state }],
});

describe('R-USAGE-3: a stale quota-axi report keeps its read time and status', () => {
  it('stamps the windows with refreshedAt, not now, and carries the stale reason', () => {
    const usage = quotaAxiUsage({
      providers: [{ ...claude, state: { status: 'stale', stale: true, refreshedAt: threeHoursAgo, error: 'fetch failed' } }],
    }, 'claude', now)!;
    expect(usage.updatedAt).toBe(now - 3 * 3600);
    expect(usage.windows.every((w) => w.updatedAt === now - 3 * 3600)).toBe(true);
    expect(usage.read).toEqual({ status: 'stale', at: now, reason: 'fetch failed' });
  });

  it('names an expired sign-in and a rate limit with its retry time', () => {
    const expired = quotaAxiUsage({
      providers: [{ ...claude, state: { status: 'stale', stale: true, refreshedAt: threeHoursAgo, reason: 'credentials_expired' } }],
    }, 'claude', now)!;
    expect(expired.read?.status).toBe('signed_out');
    const limited = quotaAxiUsage({
      providers: [{ ...claude, windows: [], state: { status: 'rate_limited', stale: false, retryAfter: '2026-10-28T14:20:00.000Z' } }],
    }, 'claude', now)!;
    expect(limited.read).toEqual({ status: 'rate_limited', at: now, retryAfter: now + 20 * 60 });
    expect(limited.windows).toEqual([]);
  });
});

describe('one read per plan account on this machine', () => {
  it('lets a second agent on the same login join the read in flight and get its own copy', async () => {
    let finish!: (stdout: string) => void;
    const run = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const posts: Array<[string, AgentUsage]> = [];
    const slots = new Map();
    const reader = (agentId: string) => new HarnessQuotaReader({
      agentId, slots, run, launch, now: () => now * 1000,
      post: async (usage) => { posts.push([agentId, usage]); },
      credentialPath: () => '/home/op/.claude/.credentials.json',
    });
    const first = reader('ruby').publish('claude', { CLAUDE_CONFIG_DIR: '/agents/ruby/claude' }, true);
    const second = reader('nerd').publish('claude', { CLAUDE_CONFIG_DIR: '/agents/nerd/claude' }, true);
    finish(JSON.stringify(verified('acct-1')));
    await expect(first).resolves.toEqual({ status: 'fresh' });
    await expect(second).resolves.toEqual({ status: 'fresh' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(posts.map(([agent]) => agent).sort()).toEqual(['nerd', 'ruby']);
    expect(posts[0]![1]).toEqual(posts[1]![1]);
    expect(posts[0]![1].account).toEqual({ provider: 'claude', key: expect.stringMatching(/^id:[0-9a-f]{32}$/) });
  });

  it("gives an agent throttled behind a sibling that sibling's read, once, without a vendor call", async () => {
    let clock = now * 1000;
    const run = vi.fn(async () => JSON.stringify(verified('acct-1')));
    const posts: string[] = [];
    const slots = new Map();
    const reader = (agentId: string) => new HarnessQuotaReader({
      agentId, slots, run, launch, now: () => clock,
      post: async () => { posts.push(agentId); },
      credentialPath: () => '/home/op/.claude/.credentials.json',
    });
    await reader('ruby').publish('claude', {});
    clock += 60_000;
    await expect(reader('nerd').publish('claude', {})).resolves.toEqual({ status: 'fresh' });
    await reader('nerd').publish('claude', {});
    expect(run).toHaveBeenCalledTimes(1);
    expect(posts).toEqual(['ruby', 'nerd']);
  });

  it('keys the account by the verified id, never the email, and keeps it for a later stale read', async () => {
    const slots = new Map();
    const posts: AgentUsage[] = [];
    const run = vi.fn(async () => JSON.stringify(verified('acct-1')));
    const reader = new HarnessQuotaReader({
      agentId: 'ruby', slots, run, launch, now: () => now * 1000,
      post: async (usage) => { posts.push(usage); },
      credentialPath: () => '/home/op/.claude/.credentials.json',
    });
    await reader.publish('claude', {}, true);
    run.mockResolvedValueOnce(JSON.stringify({
      providers: [{ ...claude, state: { status: 'stale', stale: true, refreshedAt: threeHoursAgo, reason: 'credentials_expired' } }],
    }));
    const later = new HarnessQuotaReader({
      agentId: 'ruby', slots, run, launch, now: () => (now + 3600) * 1000,
      post: async (usage) => { posts.push(usage); },
      credentialPath: () => '/home/op/.claude/.credentials.json',
    });
    await expect(later.publish('claude', {}, true)).resolves.toEqual({ status: 'signed_out' });
    expect(posts[1]!.account).toEqual(posts[0]!.account);
    expect(JSON.stringify(posts)).not.toContain('acct-1');
  });

  it('answers a failed read with a reason instead of dropping it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const posts: AgentUsage[] = [];
    const reader = new HarnessQuotaReader({
      agentId: 'ruby', slots: new Map(), launch, now: () => now * 1000,
      run: async () => { throw new Error('spawn failed'); },
      post: async (usage) => { posts.push(usage); },
      credentialPath: () => '/home/op/.claude/.credentials.json',
    });
    await expect(reader.publish('claude', {}, true)).resolves.toEqual({ status: 'failed', reason: "usage reader didn't run" });
    expect(posts[0]).toMatchObject({ windows: [], read: { status: 'failed' }, account: { provider: 'claude' } });
    expect(posts[0]!.account!.key).toMatch(/^local:[0-9a-f]{32}$/);
    error.mockRestore();
  });
});
