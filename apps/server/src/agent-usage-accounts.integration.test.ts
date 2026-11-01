import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAgentDetailView, readWorkspaceMemberListView } from '@beeline/api-contract/phone';
import { usageSummary, type AgentUsage } from '@beeline/api-contract/daemon';
import { HarnessQuotaReader, QUOTA_READ_INTERVAL_MS } from '../../body/src/harness-quota.js';
import { createUsageRefresh } from '../../body/src/agent-usage-refresh.js';
import { QUOTA_AXI_CLAUDE_REPORT } from '../../body/src/harness-quota.fixtures.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener, type LivePgClient } from './postgres-live.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const RUBY = 'a'.repeat(64);
const NERD = 'd'.repeat(64);
const OWNER = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const claude = QUOTA_AXI_CLAUDE_REPORT.providers[0]!;
const launch = () => ({ command: 'node', args: ['q.mjs'] });
const credentialPath = () => '/home/op/.claude/.credentials.json';
/** `quota-axi --provider claude --full --json` for one verified login. */
const report = (percentRemaining: number, state: Record<string, unknown> = { status: 'fresh', stale: false }) => JSON.stringify({
  ...QUOTA_AXI_CLAUDE_REPORT,
  providers: [{
    ...claude,
    windows: claude.windows.map((w) => ({ ...w, percentRemaining })),
    account: { accountId: 'acct-1', organization: 'org-1', identityStatus: 'verified' },
    state,
  }],
});

const SNAPSHOT = await (async () => {
  const database = await migratedDatabase();
  try {
    return await database.snapshot();
  } finally {
    await database.close();
  }
})();

class PgliteListenClient extends EventEmitter implements LivePgClient {
  private release?: () => Promise<void>;
  constructor(private readonly database: PgliteDatabase) {
    super();
  }
  async connect(): Promise<void> {}
  async query(): Promise<void> {
    this.release = await this.database.client.listen(POSTGRES_LIVE_CHANNEL, (payload) =>
      this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload }),
    );
  }
  async end(): Promise<void> {
    await this.release?.();
    this.release = undefined;
  }
}

let db: PgliteDatabase;
let live: LiveHub;
let listener: PostgresLiveListener;
let daemon: DaemonService;
let phone: PhoneService;

beforeEach(async () => {
  db = PgliteDatabase.fromSnapshot(SNAPSHOT);
  await db.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Ruby'),($2,'agent','Nerd'),($3,'human','Owner'),($4,'human','Other')`,
    [RUBY, NERD, OWNER, OTHER],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Usage')`, [WORKSPACE]);
  await db.query(
    `INSERT INTO agents(agent_id,owner_id,harness,machine_name) VALUES($1,$3,'claude','squire'),($2,$3,'claude','squire')`,
    [RUBY, NERD, OWNER],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member'),($1,$3,'member'),($1,$4,'owner'),($1,$5,'member')`,
    [WORKSPACE, RUBY, NERD, OWNER, OTHER],
  );
  live = new LiveHub();
  const client = new PgliteListenClient(db);
  listener = new PostgresLiveListener(db, live, () => client, 1);
  void listener.run();
  await vi.waitFor(() => expect(client.listenerCount('notification')).toBe(1));
  daemon = new DaemonService(db, live);
  phone = new PhoneService(db, 'https://server.example', undefined, undefined, live);
});

afterEach(async () => {
  await listener.stop();
  await db.close();
  vi.restoreAllMocks();
});

/** One agent's helper turn-end reader, posting through the daemon API as that agent. */
function reader(agentId: string, slots: Map<string, never>, run: () => Promise<string>, at: number) {
  return new HarnessQuotaReader({
    agentId, slots, run, launch, credentialPath, now: () => at * 1000,
    post: (usage: AgentUsage) => daemon.execute('postAgentUsage', { agentId, usage }, agentId),
  });
}

async function views(agentId: string) {
  const profile = readAgentDetailView(await phone.readAgent(WORKSPACE, agentId, OWNER))?.usage;
  const members = readWorkspaceMemberListView(await phone.readWorkspaceMembers(WORKSPACE, OWNER));
  const row = members?.agents.find((a) => a.identity.pubkey === agentId)?.usage;
  const tool = (await daemon.execute('getAgentUsage', { agentId }, agentId)) ?? undefined;
  return { profile, row, tool };
}
const numbers = (usage?: AgentUsage) => usage && {
  updatedAt: usage.updatedAt,
  windows: usage.windows.map((w) => [w.rateLimitType, w.utilization, w.updatedAt]),
  plan: usage.plan,
};

describe('R-USAGE-2: agents on one plan account report the same numbers', () => {
  it('shows the newest read on every agent of the account, everywhere', async () => {
    const now = Date.now() / 1000;
    // Nerd read the account an hour ago (its own helper slot, its own home).
    await reader(NERD, new Map(), async () => report(90), now - 3600).publish('claude', { CLAUDE_CONFIG_DIR: '/agents/nerd/claude' }, true);
    // Ruby reads it now; Nerd does not read again.
    await reader(RUBY, new Map(), async () => report(60), now).publish('claude', { CLAUDE_CONFIG_DIR: '/agents/ruby/claude' }, true);
    const ruby = await views(RUBY);
    const nerd = await views(NERD);
    expect(numbers(ruby.profile)?.windows[0]).toEqual(['five_hour', 0.4, expect.any(Number)]);
    for (const view of [ruby.row, ruby.tool, nerd.profile, nerd.row, nerd.tool])
      expect(numbers(view)).toEqual(numbers(ruby.profile));
    expect(ruby.profile?.sharedWith).toEqual(['Nerd']);
    expect(nerd.profile?.sharedWith).toEqual(['Ruby']);
    expect(usageSummary(nerd.tool)).toContain('plan shared with Ruby');
    // The account key never leaves the server, and other viewers see nothing.
    expect(JSON.stringify([ruby, nerd])).not.toMatch(/"account"|id:[0-9a-f]{32}/);
    expect((await phone.readAgent(WORKSPACE, NERD, OTHER))?.usage).toBeUndefined();
  });

  it('never merges two logins, and an in-turn Claude limit updates the whole account', async () => {
    const now = Date.now() / 1000;
    await reader(RUBY, new Map(), async () => report(60), now).publish('claude', {}, true);
    await new HarnessQuotaReader({
      agentId: NERD, slots: new Map(), launch, now: () => now * 1000,
      credentialPath: () => '/home/other/.claude/.credentials.json',
      run: async () => report(10).replace('acct-1', 'acct-2'),
      post: (usage) => daemon.execute('postAgentUsage', { agentId: NERD, usage }, NERD),
    }).publish('claude', {}, true);
    expect((await views(NERD)).profile?.windows[0]?.utilization).toBe(0.9);
    expect((await views(RUBY)).profile?.windows[0]?.utilization).toBe(0.4);
    expect((await views(RUBY)).profile?.sharedWith).toBeUndefined();
    await daemon.execute('postAgentUsage', { agentId: RUBY, usage: {
      updatedAt: now + 5,
      windows: [{ rateLimitType: 'five_hour', status: 'rejected', resetsAt: now + 600, updatedAt: now + 5 }],
      context: { used: 1000, size: 200000 },
    } }, RUBY);
    expect((await views(RUBY)).profile?.windows[0]).toMatchObject({ rateLimitType: 'five_hour', status: 'rejected' });
    expect((await views(RUBY)).profile?.context).toEqual({ used: 1000, size: 200000 });
  });

  it('stops sharing when one agent signs in to another account', async () => {
    let clock = Date.now();
    const slots = new Map();
    const accountOf: Record<string, [string, number]> = { [RUBY]: ['acct-1', 60], [NERD]: ['acct-1', 60] };
    const publish = (agentId: string, force = false) => new HarnessQuotaReader({
      agentId, slots, launch, now: () => clock,
      credentialPath: () => `/agents/${agentId}/claude/.credentials.json`,
      fingerprint: () => 'unchanged',
      run: async () => report(accountOf[agentId]![1]).replace('acct-1', accountOf[agentId]![0]),
      post: (usage) => daemon.execute('postAgentUsage', { agentId, usage }, agentId),
    }).publish('claude', {}, force);
    await publish(RUBY);
    await publish(NERD);
    expect((await views(NERD)).profile?.sharedWith).toEqual(['Ruby']);
    // Nerd's helper now reads another account, with the credential file left as it was.
    accountOf[NERD] = ['acct-2', 20];
    for (let round = 0; round < 2; round++) {
      clock += QUOTA_READ_INTERVAL_MS + 1;
      await publish(RUBY, true);
      await publish(NERD, true);
    }
    const nerd = await views(NERD);
    const ruby = await views(RUBY);
    for (const view of [nerd.profile, nerd.row, nerd.tool]) expect(view?.windows[0]?.utilization).toBe(0.8);
    for (const view of [ruby.profile, ruby.row, ruby.tool]) expect(view?.windows[0]?.utilization).toBe(0.4);
    expect(nerd.profile?.sharedWith).toBeUndefined();
    expect(ruby.profile?.sharedWith).toBeUndefined();
    expect(usageSummary(nerd.tool)).not.toContain('shared with');
  });

  it('shows the new account on a refresh a second after the sign-in', async () => {
    let clock = Date.now();
    let login = 'login acct-1';
    let account: [string, number] = ['acct-1', 60];
    const run = vi.fn(async () => report(account[1]).replace('acct-1', account[0]));
    const nerdReader = new HarnessQuotaReader({
      agentId: NERD, slots: new Map(), launch, now: () => clock, run,
      credentialPath: () => `/agents/${NERD}/claude/.credentials.json`,
      fingerprint: () => login,
      post: (usage) => daemon.execute('postAgentUsage', { agentId: NERD, usage }, NERD),
    });
    await nerdReader.publish('claude', {}, true);
    expect((await views(NERD)).profile?.windows[0]?.utilization).toBe(0.4);
    // `claude /login` to another account rewrites the credential file.
    login = 'login acct-2';
    account = ['acct-2', 20];
    clock += 1_000;
    await expect(nerdReader.publish('claude', {}, true)).resolves.toEqual({ status: 'fresh' });
    expect(run).toHaveBeenCalledTimes(2);
    const nerd = await views(NERD);
    for (const view of [nerd.profile, nerd.row, nerd.tool]) expect(view?.windows[0]?.utilization).toBe(0.8);
  });
});

describe('R-USAGE-3: a stale fallback is never shown as fresh', () => {
  it('keeps quota-axi refreshedAt as the updated time and carries the status to the phone', async () => {
    const now = Date.now() / 1000;
    const refreshedAt = new Date((now - 3 * 3600) * 1000).toISOString();
    await reader(RUBY, new Map(), async () => report(70, { status: 'stale', stale: true, refreshedAt, error: 'fetch failed' }), now)
      .publish('claude', {}, true);
    const { profile, tool } = await views(RUBY);
    expect(profile?.updatedAt).toBeCloseTo(now - 3 * 3600, 0);
    expect(profile?.read).toMatchObject({ status: 'stale', reason: 'fetch failed' });
    expect(usageSummary(tool)).toMatch(/\(couldn't read: fetch failed\)\.$/);
  });

  it('keeps a stale credit-only Codex balance and its real read time on every view', async () => {
    const now = Date.now() / 1000;
    const refreshedAt = new Date((now - 3 * 3600) * 1000).toISOString();
    const codex = JSON.stringify({ providers: [{
      provider: 'codex', windows: [], credits: { unit: 'credits', remaining: 123 },
      account: { accountId: 'acct-1', organization: 'org-1', identityStatus: 'verified' },
      state: { status: 'stale', stale: true, refreshedAt, error: 'network failed' },
    }] });
    await reader(RUBY, new Map(), async () => codex, now).publish('codex', {}, true);
    const { profile, row, tool } = await views(RUBY);
    for (const usage of [profile, row, tool]) {
      expect(usage?.credits).toEqual({ remaining: 123 });
      expect(usage?.updatedAt).toBeCloseTo(now - 3 * 3600, 0);
    }
    expect(profile?.read).toMatchObject({ status: 'stale', reason: 'network failed' });
    expect(usageSummary(tool)).toMatch(/^Usage: 123 credits left, as of .*\(couldn't read: network failed\)\.$/);
  });

  it('keeps OpenRouter key spend and its read time through a context-only update', async () => {
    const now = Date.now() / 1000;
    const spend = { today: 9.75, week: 16.4, limit: 20, remaining: 3.6 };
    await daemon.execute('postAgentUsage', { agentId: RUBY, usage: { updatedAt: now, windows: [], spend } }, RUBY);
    const spentAt = (await views(RUBY)).profile!.updatedAt;
    await daemon.execute('postAgentUsage', { agentId: RUBY, usage: {
      updatedAt: now + 60, windows: [], context: { used: 1000, size: 200000 },
    } }, RUBY);
    const { profile, row, tool } = await views(RUBY);
    for (const usage of [profile, row, tool]) {
      expect(usage?.spend).toEqual(spend);
      expect(usage?.updatedAt).toBe(spentAt);
    }
    expect(profile?.context).toEqual({ used: 1000, size: 200000 });
    expect(usageSummary(tool)).toContain('$3.60');
  });
});

describe('R-USAGE-4: the updated time is never newer than the oldest number', () => {
  it('stamps a partial merge with its oldest window', async () => {
    const now = Date.now() / 1000;
    const window = (rateLimitType: string, at: number) => ({ updatedAt: at, windows: [{ rateLimitType, status: 'allowed' as const, utilization: 0.2, updatedAt: at }] });
    await daemon.execute('postAgentUsage', { agentId: RUBY, usage: window('seven_day', now - 3 * 86_400) }, RUBY);
    await daemon.execute('postAgentUsage', { agentId: RUBY, usage: window('five_hour', now) }, RUBY);
    const { profile } = await views(RUBY);
    expect(profile?.windows).toHaveLength(2);
    expect(profile?.updatedAt).toBeCloseTo(now - 3 * 86_400, 0);
  });

  it('drops windows a new quota-axi read no longer reports', async () => {
    const now = Date.now() / 1000;
    await daemon.execute('postAgentUsage', { agentId: RUBY, usage: { updatedAt: now, windows: [
      { rateLimitType: 'seven_day_opus', status: 'allowed', utilization: 0.5, updatedAt: now },
    ] } }, RUBY);
    await reader(RUBY, new Map(), async () => report(60), now).publish('claude', {}, true);
    expect((await views(RUBY)).profile?.windows.map((w) => w.rateLimitType)).toEqual(['five_hour', 'seven_day', 'model_fable']);
  });
});

describe('R-USAGE-5: a refresh always answers', () => {
  it('answers offline in under a second when the agent machine is not connected', async () => {
    const started = Date.now();
    await expect(phone.execute('refreshAgentUsage', { workspaceId: WORKSPACE, agentId: RUBY }, OWNER))
      .resolves.toEqual({ status: 'offline' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("waits for the helper's answer and returns its reason", async () => {
    await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id) VALUES($1,1,'c','i')`, [RUBY]);
    const now = Date.now() / 1000;
    const refresh = createUsageRefresh({
      api: { execute: ((name: string, input: never) => daemon.execute(name as never, input, RUBY)) as never },
      agentId: RUBY, kind: 'claude', env: {},
      reader: reader(RUBY, new Map(), async () => report(60, { status: 'rate_limited', stale: false, retryAfter: new Date((now + 600) * 1000).toISOString() }), now),
    });
    // What daemon-live forwards to Ruby's helper session.
    const answered: Promise<void>[] = [];
    live.subscribeAll((event) => {
      if (event.type === 'usage-refresh' && event.agentId === RUBY) answered.push(refresh(event.requestId));
    });
    await expect(phone.execute('refreshAgentUsage', { workspaceId: WORKSPACE, agentId: RUBY }, OWNER))
      .resolves.toEqual({ status: 'rate_limited', retryAfter: expect.closeTo(now + 600, 0) });
    await Promise.all(answered);
    expect((await views(RUBY)).profile?.read).toMatchObject({ status: 'rate_limited' });
  });

  it('settles for an older helper that only posts its read', async () => {
    await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id) VALUES($1,1,'c','i')`, [RUBY]);
    const posted: Promise<unknown>[] = [];
    live.subscribeAll((event) => {
      // A helper from before request ids posts its quota-axi read and nothing else.
      if (event.type === 'usage-refresh' && event.agentId === RUBY)
        posted.push(daemon.execute('postAgentUsage', { agentId: RUBY, usage: { updatedAt: Date.now() / 1000, plan: 'max', windows: [
          { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.1, updatedAt: Date.now() / 1000 },
        ] } }, RUBY));
    });
    await expect(phone.execute('refreshAgentUsage', { workspaceId: WORKSPACE, agentId: RUBY }, OWNER))
      .resolves.toEqual({ status: 'fresh' });
    await Promise.all(posted);
  });

  it("answers no_answer when a connected helper never replies", async () => {
    await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id) VALUES($1,1,'c','i')`, [RUBY]);
    const { requestUsageRefresh } = await import('./agent-usage.js');
    await expect(requestUsageRefresh(db, live, RUBY, { timeoutMs: 50 })).resolves.toEqual({ status: 'no_answer' });
  });
});
