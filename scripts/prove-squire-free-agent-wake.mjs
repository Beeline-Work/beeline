/** R-SQUIRE-SLEEP: built HTTP pair -> committed notification -> wake -> sign-in -> sleep. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { FreeAgentService, freeAgentConfigFromEnv } from '../apps/server/dist/free-agents.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { PostgresLiveListener, POSTGRES_LIVE_CHANNEL } from '../apps/server/dist/postgres-live.js';
import { claimAgentConnection } from '../apps/server/dist/connection-presence.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const OWNER = 'a'.repeat(64);
const db = new PgliteDatabase();
const live = new LiveHub();
const states = new Map();
const calls = [];
const machines = {
  async create() { states.set('proof-machine', 'started'); return { id: 'proof-machine' }; },
  async find() { return undefined; },
  async start(id) { calls.push(`start ${id}`); states.set(id, 'started'); },
  async suspend(id) { calls.push(`suspend ${id}`); states.set(id, 'suspended'); },
  async stop(id) { calls.push(`stop ${id}`); states.set(id, 'stopped'); },
  async destroy(id) { states.delete(id); },
  async state(id) { return states.get(id); },
  async waitFor() {},
};
// Only the SQL transport is replaced; production notification projection runs below.
class ListenClient extends EventEmitter {
  async connect() {}
  async query(sql) {
    assert.equal(sql, `LISTEN ${POSTGRES_LIVE_CHANNEL}`);
    this.release = await db.client.listen(POSTGRES_LIVE_CHANNEL, payload =>
      this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload }));
  }
  async end() {
    const release = this.release;
    this.release = undefined;
    await release?.();
    this.emit('end');
  }
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    assert(Date.now() < deadline, 'proof deadline exceeded');
    await delay(10);
  }
}

// Explicit test config: no production environment, Fly client, model or lifecycle commands.
const config = freeAgentConfigFromEnv({ BEELINE_FREE_AGENT_SEAL_KEY: 'isolated-proof',
  FLY_FREE_AGENT_IMAGE: 'isolated-image' }, 'http://proof');
assert(config);
const auth = new TokenAuth(db, async () => ({ subject: 'squire-wake-proof', login: 'proof', name: 'Proof' }));
const free = new FreeAgentService(db, config, machines,
  agent => auth.createDaemonExchange(agent), () => {});
const phone = new PhoneService(db, 'http://proof', undefined, undefined, live);
phone.setFreeAgents(free);
const daemon = new DaemonService(db, live);
const server = createBeelineServer({ database: db, auth, live, phone, daemon, mediaMaximumBytes: 1024 });
const client = new ListenClient();
const listener = new PostgresLiveListener(db, live, () => client, 1);
let listenerRun;
let off;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Proof','proof')`, [OWNER]);
  await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('github','squire-wake-proof',$1,'https://github.com','beeline','proof')`, [OWNER]);
  const workspace = await phone.execute('createWorkspace', { name: 'Isolated Squire wake' }, OWNER);
  const { agent_id: agent } = (await db.query(`SELECT agent_id FROM free_agents
    WHERE workspace_id=$1 AND starter_role='beebee'`, [workspace.id])).rows[0];
  await free.provision(agent);
  await db.query(`UPDATE free_agents SET state='running' WHERE agent_id=$1`, [agent]);
  assert.deepEqual(await free.requestSleep(agent), { sleep: true });
  await until(() => states.get('proof-machine') === 'suspended');
  await delay(100); // Drain the post-suspend recovery kick before pairing.
  calls.length = 0;
  off = free.subscribeToWakes(live);
  listenerRun = listener.run();
  await until(() => client.listenerCount('notification') > 0);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const phoneToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
  const daemonToken = (await auth.exchangeDaemonToken((await auth.createDaemonExchange(agent)).exchangeToken)).daemonToken;
  async function call(surface, operation, input) {
    const response = await fetch(`${origin}/v1/${surface}/operations/${operation}`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        authorization: `Bearer ${surface === 'phone' ? phoneToken : daemonToken}` },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200, `${operation}: ${await response.clone().text()}`);
    return response.json();
  }
  const pairing = await call('phone', 'pairConnector', { helperAgentId: agent, connectorType: 'trusty-squire' });
  assert.equal(pairing.status.status, 'installing');
  await until(() => states.get('proof-machine') === 'started');
  assert.deepEqual(calls, ['start proof-machine']);
  await db.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('proof',now())`);
  await claimAgentConnection(db, live, agent, { lifecycleId: 'proof' }, { connectionId: 'proof', instanceId: 'proof' });
  const { assignments } = await call('daemon', 'getConnectorAssignments', {});
  const install = assignments.find(a => a.kind === 'install');
  assert(install, 'reconnected helper must receive the queued install');
  await call('daemon', 'postConnectorStatus', { connectorId: pairing.connectorId,
    pairingGeneration: install.pairingGeneration, steps: [],
    signIn: { method: 'streamed-page', url: 'https://signin.example.test' } });
  const status = await call('phone', 'readConnectorInstall', { connectorId: pairing.connectorId });
  assert.equal(status.status.signIn.url, 'https://signin.example.test');
  await db.query(`UPDATE free_agents SET last_activity_at=now()-interval '10 minutes',
    wake_requested_at=now()-interval '10 minutes' WHERE agent_id=$1`, [agent]);
  assert.deepEqual(await free.requestSleep(agent), { sleep: false });
  await free.sweep();
  assert.equal(states.get('proof-machine'), 'started');
  await call('daemon', 'installConnector', { connectorId: pairing.connectorId,
    pairingGeneration: install.pairingGeneration, connectorType: 'trusty-squire', signedInAs: 'proof' });
  assert.deepEqual(await free.requestSleep(agent), { sleep: true });
  await until(() => states.get('proof-machine') === 'suspended');
  console.log('PASS R-SQUIRE-SLEEP: suspended -> phone pair -> committed notification -> started -> helper install assignment -> phone sign-in surface -> sleep refused -> completion -> suspended');
  console.log('Stand-ins: PGlite, stateful Machines API, simulated helper reconnect and sign-in report. No live Fly/helper/browser timing claimed.');
} finally {
  off?.();
  await listener.stop();
  await listenerRun;
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await delay(100);
  await db.close();
}
