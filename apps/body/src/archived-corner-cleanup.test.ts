import { it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { reclaimArchivedMemberStorage, rememberStorageOwner } from './storage-owners.js';
import { declareCornerProofOutput } from './corner-proof-output.js';

it.skipIf(process.platform !== 'linux')('ARCHIVED-OUTPUT-1 deletes closed dirty/unpushed/proof data and stops its child; preserves open and unknown', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-closed-corner-'));
  const path = resolve(root, 'beeline/corners/closed');
  execFileSync('git', ['init', '-q', path]);
  await writeFile(resolve(path, 'source'), 'unpublished');
  execFileSync('git', ['-C', path, 'add', '.']);
  execFileSync('git', ['-C', path, '-c', 'user.name=Proof', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'unpublished']);
  await writeFile(resolve(path, 'dirty'), 'discard on close');
  await declareCornerProofOutput(path, 'closed');
  const home = resolve(root, 'beeline/agents', 'a'.repeat(64), 'rooms/closed');
  await mkdir(home, { recursive: true }); await writeFile(resolve(home, 'data'), 'private');
  await rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'closed', itemId: 'closed', kind: 'corners' });
  const brokerScript = resolve(path, 'trusty-squire-broker.cjs');
  await writeFile(brokerScript, 'setInterval(()=>{},1000)');
  const broker = spawn(process.execPath, [brokerScript], { cwd: path, stdio: 'ignore' });
  const openRoot = resolve(root, 'beeline/corners/open');
  await mkdir(openRoot, { recursive: true });
  const openChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: openRoot, stdio: 'ignore' });
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: path, stdio: 'ignore' });
  await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail); });
  const exited = new Promise<void>(done => child.once('exit', () => done()));
  try {
    for (const states of [[], [{ roomId: 'closed', archived: false }]]) {
      await reclaimArchivedMemberStorage(root, states);
      expect(await access(path).then(() => true, () => false)).toBe(true);
      expect(child.exitCode).toBe(null);
    }
    await reclaimArchivedMemberStorage(root, [{ roomId: 'closed', archived: true }]);
    expect(await access(path).then(() => true, () => false)).toBe(false);
    expect(await access(home).then(() => true, () => false)).toBe(false);
    await exited;
    expect(broker.exitCode).toBe(null);
    expect(broker.signalCode).toBe(null);
    expect(openChild.exitCode).toBe(null);
    expect(openChild.signalCode).toBe(null);
    expect(await access(openRoot).then(() => true, () => false)).toBe(true);
  } finally { broker.kill('SIGKILL'); openChild.kill('SIGKILL'); child.kill('SIGKILL'); await exited; await rm(root, { recursive: true, force: true }); }
}, 30_000);
