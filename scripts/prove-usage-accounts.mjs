/** Live proof for Usage truth: two agents on one real Claude login, one refresh.
 * Real server stack (PGlite, NOTIFY listener, HTTP and helper WebSockets), real
 * helper refresh code and a real quota-axi read of this machine's Claude login.
 * Each agent gets its own CLAUDE_CONFIG_DIR linking the operator credential,
 * the way Beeline agent homes do. Only the disposable local database is written.
 *
 *   node --import tsx scripts/prove-usage-accounts.mjs
 */
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { usageSummary } from '../packages/api-contract/src/agent-usage.ts';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/src/database.ts';
import { PhoneService } from '../apps/server/src/phone-service.ts';
import { DaemonService } from '../apps/server/src/daemon-service.ts';
import { LiveHub } from '../apps/server/src/live.ts';
import { PostgresLiveListener, POSTGRES_LIVE_CHANNEL } from '../apps/server/src/postgres-live.ts';
import { createBeelineServer } from '../apps/server/src/server.ts';
import { DaemonApiClient } from '../apps/body/src/daemon-api-client.ts';
import { createUsageRefresh } from '../apps/body/src/agent-usage-refresh.ts';
import { HarnessQuotaReader, quotaAxiLaunch } from '../apps/body/src/harness-quota.ts';

const OUT = '.scratch/usage-truth';
const OWNER = 'a'.repeat(64), NIGLET = 'c'.repeat(64), BBC = 'd'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const credential = process.env.USAGE_PROOF_CLAUDE_CREDENTIAL ?? join(homedir(), '.claude', '.credentials.json');
await mkdir(OUT, { recursive: true });
const homes = {};
for (const [id, name] of [[NIGLET, 'niglet'], [BBC, 'bbc']]) {
  const dir = join('/tmp/usage-truth-homes', name, 'claude');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await symlink(credential, join(dir, '.credentials.json'));
  homes[id] = { ...process.env, CLAUDE_CONFIG_DIR: dir };
}

const database = new PgliteDatabase();
await migrate(database);
await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES ($1,'human','Owner','owner'),($2,'agent','Niglet','niglet'),($3,'agent','BBC','bbc')`, [OWNER, NIGLET, BBC]);
await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Usage proof')`, [WORKSPACE]);
await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [ROOM, WORKSPACE]);
await database.query(`INSERT INTO agents(agent_id,owner_id,harness,machine_name) VALUES($1,$3,'claude','chad'),($2,$3,'claude','chad')`, [NIGLET, BBC, OWNER]);
for (const [id, role] of [[OWNER, 'owner'], [NIGLET, 'member'], [BBC, 'member']])
  for (const room of [null, ROOM])
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`, [WORKSPACE, room, id, role]);
// Before: each agent holds its own copy, read at a different time (today's per-agent snapshots).
const legacy = (at, used) => ({ updatedAt: at, plan: 'max', windows: [
  { rateLimitType: 'five_hour', status: 'allowed', utilization: used, updatedAt: at },
  { rateLimitType: 'seven_day', status: 'allowed', utilization: used / 2, updatedAt: at },
] });
const now = Date.now() / 1000;
await database.query(`UPDATE agents SET usage_snapshot=$2::jsonb WHERE agent_id=$1`, [NIGLET, JSON.stringify(legacy(now - 3600, 0.31))]);
await database.query(`UPDATE agents SET usage_snapshot=$2::jsonb WHERE agent_id=$1`, [BBC, JSON.stringify(legacy(now - 3 * 3600, 0.07))]);

const live = new LiveHub();
class ListenClient extends EventEmitter {
  async connect() {}
  async query() { this.release = await database.client.listen(POSTGRES_LIVE_CHANNEL, (payload) => this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload })); }
  async end() { await this.release?.(); }
}
const listener = new PostgresLiveListener(database, live, () => new ListenClient(), 10);
void listener.run();
const phone = new PhoneService(database, 'http://local.test', undefined, undefined, live);
const daemon = new DaemonService(database, live);
const tokens = { [`bdt_${'n'.repeat(43)}`]: NIGLET, [`bdt_${'b'.repeat(43)}`]: BBC };
const server = createBeelineServer({ database, live, phone, daemon,
  auth: { authenticateDaemon: async (token) => tokens[token] ?? null, authenticatePhone: async () => null }, mediaMaximumBytes: 1 });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// One helper process: both agents share its read slots. Count real vendor reads.
let vendorReads = 0;
const launch = quotaAxiLaunch();
const run = (command, env) => new Promise((resolve, reject) => {
  vendorReads += 1;
  execFile(command.command, command.args, { env, timeout: 30_000, maxBuffer: 1024 * 1024 },
    (error, stdout) => (stdout ? resolve(stdout) : reject(error ?? new Error('quota-axi printed nothing'))));
});
const slots = new Map();
const helpers = {};
for (const [token, agentId] of Object.entries(tokens)) {
  const api = new DaemonApiClient(baseUrl, token, agentId, fetch, (url, protocols) => new WebSocket(url, protocols));
  const reader = new HarnessQuotaReader({ agentId, slots, run, launch: () => launch,
    post: (usage) => api.execute('postAgentUsage', { agentId, usage }) });
  const refresh = createUsageRefresh({ api, agentId, kind: 'claude', env: homes[agentId], reader });
  api.setUsageRefreshListener((requestId) => { void refresh(requestId); });
  helpers[agentId] = { api, refresh };
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('helper subscription timeout')), 10_000);
    api.liveSubscribe(ROOM, undefined, () => undefined, (connected) => { if (connected) { clearTimeout(timeout); resolve(); } });
  });
  await database.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id) VALUES($1,1,$2,'proof')
    ON CONFLICT (agent_id) DO NOTHING`, [agentId, `proof-${agentId.slice(0, 4)}`]);
}

async function views(agentId) {
  const profile = (await phone.readAgent(WORKSPACE, agentId, OWNER))?.usage;
  const row = (await phone.readWorkspaceMembers(WORKSPACE, OWNER))?.agents.find((a) => a.identity.pubkey === agentId)?.usage;
  const tool = (await daemon.execute('getAgentUsage', { agentId }, agentId)) ?? undefined;
  return { profile, row, tool, summary: usageSummary(tool) };
}
const numbers = (u) => u && { updatedAt: u.updatedAt, plan: u.plan, windows: u.windows.map((w) => [w.rateLimitType, w.utilization]) };
const before = { niglet: await views(NIGLET), bbc: await views(BBC) };

// Helper start: each hosted agent joins its plan account (agent-runtime.ts).
await Promise.all(Object.values(helpers).map(({ refresh }) => refresh.attach()));
const attached = { vendorReads, same: JSON.stringify(numbers((await views(NIGLET)).profile)) === JSON.stringify(numbers((await views(BBC)).profile)) };
// Push the shared read slot past the refresh reuse window so the refresh asks the vendor again.
for (const slot of slots.values()) slot.lastStartedAt -= 60_000;

// One refresh, requested for Niglet only.
let started = Date.now();
const outcome = await phone.execute('refreshAgentUsage', { workspaceId: WORKSPACE, agentId: NIGLET }, OWNER);
const refreshMs = Date.now() - started;
const after = { niglet: await views(NIGLET), bbc: await views(BBC) };
const same = [after.niglet.row, after.niglet.tool, after.bbc.profile, after.bbc.row, after.bbc.tool]
  .every((view) => JSON.stringify(numbers(view)) === JSON.stringify(numbers(after.niglet.profile)));

// An agent whose machine holds no connection answers at once.
await database.query(`UPDATE agent_connections SET released_at=now() WHERE agent_id=$1`, [BBC]);
started = Date.now();
const offline = await phone.execute('refreshAgentUsage', { workspaceId: WORKSPACE, agentId: BBC }, OWNER);
const offlineMs = Date.now() - started;

const result = {
  before: { niglet: numbers(before.niglet.profile), bbc: numbers(before.bbc.profile), nigletSays: before.niglet.summary, bbcSays: before.bbc.summary },
  helperStart: attached,
  refresh: { outcome, ms: refreshMs, vendorReadsTotal: vendorReads },
  after: {
    niglet: numbers(after.niglet.profile), bbc: numbers(after.bbc.profile),
    identicalOnProfileMembersAndTool: same,
    nigletSharedWith: after.niglet.profile?.sharedWith, bbcSharedWith: after.bbc.profile?.sharedWith,
    read: after.niglet.profile?.read,
    nigletSays: after.niglet.summary, bbcSays: after.bbc.summary,
  },
  offline: { outcome: offline, ms: offlineMs },
};
await writeFile(join(OUT, 'live-proof.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
for (const { api } of Object.values(helpers)) api.closeLive();
await listener.stop();
server.close();
await database.close();
process.exit(same && outcome.status === 'fresh' && offline.status === 'offline' ? 0 : 1);
