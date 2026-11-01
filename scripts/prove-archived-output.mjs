// ARCHIVED-OUTPUT-1: built storage report and host sweep on a throwaway dirty checkout.
import { mkdtemp, mkdir, writeFile, readdir, lstat, utimes, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { rememberStorageOwner, pruneArchivedCheckoutStorage, reclaimArchivedMemberStorage } from '../apps/body/dist/storage-owners.js';
import { helperStorageReport } from '../apps/body/dist/storage-report.js';
const root = await mkdtemp(join(tmpdir(), 'beeline-archived-output-'));
const checkout = join(root, 'beeline/corners/' + 'f'.repeat(64));
let child;
const exists = path => access(path).then(() => true, () => false);
async function age(path) {
  if ((await lstat(path)).isDirectory()) for (const name of await readdir(path)) await age(join(path, name));
  await utimes(path, new Date('2000-01-01'), new Date('2000-01-01'));
}
try {
  execFileSync('git', ['init', '-q', checkout]);
  await writeFile(join(checkout, '.gitignore'), 'build/\n.codegraph/\n');
  await writeFile(join(checkout, 'source'), 'unpublished source');
  for (const category of ['build', '.codegraph']) {
    await mkdir(join(checkout, category));
    await writeFile(join(checkout, category, 'output'), 'x'.repeat(8192));
    await age(join(checkout, category));
  }
  await rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'proof', kind: 'corners', itemId: 'f'.repeat(64), ended: true, endedAt: Date.now() - 9 * 86400_000 });
  child = spawn(process.execPath, ['-e', "process.on('message',p=>{require('fs').openSync(p,'r');process.send('ready')});setInterval(()=>{},1000)"], { cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise((done, fail) => { child.once('message', done); child.once('error', fail); child.send(join(checkout, 'build/output')); });
  const exited = new Promise(done => child.once('exit', done));
  const report = await helperStorageReport(root);
  assert.ok(report);
  assert.ok(await exists(join(checkout, 'build')), 'report must be read-only');
  await pruneArchivedCheckoutStorage(root);
  assert.equal(await exists(checkout), true, 'ended membership is not archive authority');
  for (const states of [[], [{ roomId: 'proof', archived: false }]]) {
    await reclaimArchivedMemberStorage(root, states);
    assert.equal(await exists(checkout), true);
    assert.equal(child.signalCode, null);
  }
  await reclaimArchivedMemberStorage(root, [{ roomId: 'proof', archived: true }]);
  assert.equal(await exists(join(checkout, 'build')), false);
  assert.equal(await exists(join(checkout, '.codegraph')), false);
  assert.equal(await exists(checkout), false);
  await exited;
  console.log('ARCHIVED-OUTPUT-1 PASS: built report identifies stale output; host sweep stops the child and deletes the entire dirty checkout');
} finally { child?.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }

// The reconciliation path must also clean homes with no checkout/owner record.
const homeRoot = await mkdtemp(join(tmpdir(), 'beeline-archived-home-'));
const home = join(homeRoot, 'beeline/agents', 'a'.repeat(64), 'rooms/proof');
let homeChild;
try {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'data'), 'private');
  homeChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: home, stdio: 'ignore' });
  await new Promise((done, fail) => { homeChild.once('spawn', done); homeChild.once('error', fail); });
  const exited = new Promise(done => homeChild.once('exit', done));
  for (const states of [[], [{ roomId: 'proof', archived: false }]]) {
    await reclaimArchivedMemberStorage(homeRoot, states);
    assert.equal(await exists(home), true);
    assert.equal(homeChild.exitCode, null);
    assert.equal(homeChild.signalCode, null);
  }
  await reclaimArchivedMemberStorage(homeRoot, [{ roomId: 'proof', archived: true }]);
  assert.equal(await exists(home), false);
  await exited;
  console.log('ARCHIVED-OUTPUT-1 PASS: built reconciliation preserves unknown/open homes; archived home without owner or checkout is deleted and child stopped');
} finally { homeChild?.kill('SIGKILL'); await rm(homeRoot, { recursive: true, force: true }); }

// Runtime-local repository-free rooms are outside the indexed agent home.
const { RoomRuntimeCoordinator } = await import('../apps/body/dist/room-runtime.js');
const { identityFromKey } = await import('../apps/body/dist/runtime.js');
const localRoot = await mkdtemp(join(tmpdir(), 'beeline-runtime-scratch-'));
const scratch = join(localRoot, 'rooms/chat-corner/scratch');
let scratchChild, coordinator;
try {
  await mkdir(scratch, { recursive: true });
  await writeFile(join(scratch, 'work.txt'), 'scratch');
  scratchChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: scratch, stdio: 'ignore' });
  await new Promise((done, fail) => { scratchChild.once('spawn', done); scratchChild.once('error', fail); });
  const exited = new Promise(done => scratchChild.once('exit', done));
  const identity = identityFromKey('11'.repeat(32), 'Proof');
  let state;
  coordinator = new RoomRuntimeCoordinator({
    agent: { name: 'Proof', publicKey: identity.publicKey, secretKeyHex: Buffer.from(identity.secretKey).toString('hex') },
    rooms: [], communityId: 'workspace', supervisorRoot: localRoot,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
  }, join(localRoot, 'agent.json'), { workspaceRoot: localRoot }, {
    daemonApi: { execute: async () => { if (!state) throw new Error('unknown'); return state; } },
  });
  for (state of [undefined, { archived: false }]) {
    assert.equal(await coordinator.cleanupArchivedCornerLocalState('chat-corner'), false);
    assert.equal(await exists(join(scratch, 'work.txt')), true);
    assert.equal(scratchChild.signalCode, null);
  }
  state = { archived: true };
  assert.equal(await coordinator.cleanupArchivedCornerLocalState('chat-corner'), true);
  await exited;
  assert.equal(await exists(scratch), false);
  console.log('ARCHIVED-OUTPUT-1 PASS: built runtime-local cleanup stops child and removes scratch; open/unknown preserved');
} finally { scratchChild?.kill('SIGKILL'); await coordinator?.shutdown(); await rm(localRoot, { recursive: true, force: true }); }
