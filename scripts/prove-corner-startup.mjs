// Run after npm run build: node --import tsx scripts/prove-corner-startup.mjs.
// --base asserts the old failures using a build of the previous implementation.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { materializeCornerWorktree } from '../apps/body/dist/room-runtime.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createAgentCommand } from '../apps/server/dist/agent-command.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const git = promisify(execFile);
const baseline = process.argv.includes('--base');
// Only a throwaway file remote is used; no GitHub credential launcher is needed.
process.env.PATH = `/usr/bin:/bin:${process.env.PATH ?? ''}`;
const root = await mkdtemp(resolve(tmpdir(), 'beeline-startup-proof-'));
const db = new PgliteDatabase();
let server;
try {
  const seed = resolve(root, 'seed'), remote = resolve(root, 'remote.git');
  await git('git', ['init', '-b', 'main', seed]);
  await writeFile(resolve(seed, 'hello.txt'), 'isolated startup proof\n');
  await git('git', ['-C', seed, 'add', '.']);
  await git('git', ['-C', seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Seed']);
  await git('git', ['clone', '--bare', seed, remote]);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => materializeCornerWorktree({
    cornerId: `proof-${index}`, remote: pathToFileURL(remote).href, targetBranch: 'main',
    featureBranch: `feature/proof-${index}`, token: 'unused', supervisorRoot: root,
    workspaceId: 'fixture', committer: { name: 'Fixture', publicKey: 'b'.repeat(64) },
  })));
  const failures = results.filter(result => result.status === 'rejected');
  if (baseline) assert.ok(failures.length > 0);
  else {
    assert.equal(failures.length, 0, failures.map(result => result.reason.message).join('\n'));
    for (const [index, result] of results.entries()) {
      assert.equal((await git('git', ['-C', result.value.path, 'branch', '--show-current'])).stdout.trim(), `feature/proof-${index}`);
      assert.equal((await git('git', ['-C', result.value.path, 'status', '--porcelain'])).stdout, '');
    }
  }
  console.log(`STARTUP-RACE-1: real Git corner setup; failed=${failures.length}; completed=${results.length - failures.length}`);

  await migrate(db);
  const owner = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const parent = '22222222-2222-4222-8222-222222222222', corner = '33333333-3333-4333-8333-333333333333';
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`, [owner, commander, worker]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [commander, worker, owner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Fixture')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Parent',$3),($4,$2,'Corner',$5)`, [parent, workspace, owner, corner, commander]);
  await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [parent, corner]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,worker_agent_id,objective) VALUES($1,$2,$2,'Prove startup failure')`, [corner, worker]);
  for (const identity of [owner, commander, worker]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, identity, parent]);
  const command = await createAgentCommand(db, { roomId: corner, agentId: worker, sourceMessageId: null, reason: 'order', privatePayload: { kind: 'order', text: 'Prove startup', authorId: commander, fromRoomId: parent } });
  const token = 'bdt_startup_fixture_123456789';
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(token), worker]);
  const live = new LiveHub(), daemon = new DaemonService(db, live);
  daemon.warmConnectorIndex = async () => {};
  server = createBeelineServer({ database: db, daemon, live, auth: new TokenAuth(db, async () => { throw new Error('unused'); }), phone: new PhoneService(db, 'http://test'), mediaMaximumBytes: 1 });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (operation, input) => {
    const response = await fetch(`${origin}/v1/daemon/operations/${operation}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  assert.equal((await call('getCornerRestoreState', { cornerId: corner })).state, 'working');
  await call('postAgentTurnReceipt', { roomId: corner, requestId: command.turn_request_id, status: 'failed', reasonKind: 'workspace-failure', reason: 'git fetch failed: cannot lock ref' });
  const restored = await call('getCornerRestoreState', { cornerId: corner });
  const conversation = await call('getRoomConversation', { roomId: corner });
  const visibleFailure = JSON.stringify(conversation).includes('cannot lock ref');
  assert.equal(restored.state, baseline ? 'working' : 'idle');
  assert.equal(visibleFailure, !baseline);
  console.log(`STARTUP-FAILURE-1: HTTP receipt and corner reads; state=${restored.state}; visibleFailure=${visibleFailure}`);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await db.close();
  await rm(root, { recursive: true, force: true });
}
