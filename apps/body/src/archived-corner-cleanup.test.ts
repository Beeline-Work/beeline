import { promisify } from 'node:util';
import { readlinkSync, readFileSync, readdirSync } from 'node:fs';
const scans = vi.hoisted(() => ({ files: [] as string[][], argv: [] as number[][] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mocked = (...args: any[]) => {
    if (args[0] === '/usr/bin/python3' && args[1][1].includes('KERN_PROCARGS2')) {
      const callback = args.at(-1);
      const requested = JSON.parse(args[1][2]);
      if (typeof requested === 'number') {
        scans.argv.push([requested]);
        try { callback(null, JSON.stringify(readFileSync(`/proc/${requested}/cmdline`, 'utf8').split('\0').filter(Boolean)), ''); }
        catch (error) { callback(error, '', ''); }
        return;
      }
      scans.argv.push(requested);
      try { callback(null, JSON.stringify(Object.fromEntries(JSON.parse(args[1][2]).flatMap((pid: number) => {
        try { return [[pid, readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)]]; } catch { return []; }
      }))), ''); }
      catch (error) { callback(error, '', ''); }
      return;
    }
    if (args[0] === '/sbin/mount') args[0] = '/bin/mount';
    if (args[0] === '/usr/sbin/lsof') {
      scans.files.push(args[1]);
      const callback = args.at(-1);
      try {
        const pids = args[1].includes('-p') ? [args[1][2]] : readdirSync('/proc').filter(pid => /^\d+$/.test(pid));
        const paths = pids.flatMap((pid: string) => {
          const base = `/proc/${pid}`;
          try { return ['p' + pid, ...['cwd', ...readdirSync(base + '/fd').map(fd => 'fd/' + fd)].flatMap(name => {
            try { return ['n/private' + readlinkSync(base + '/' + name)]; } catch { return []; }
          })]; } catch { return []; }
        });
        callback(null, paths.join('\n'), '');
      }
      catch (error) { callback(error, '', ''); }
      return;
    }
    return (actual.execFile as Function)(...args);
  };
  Object.defineProperty(mocked, promisify.custom, { value: (...args: any[]) => new Promise((resolve, reject) => mocked(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }))) });
  return { ...actual, execFile: mocked };
});
import { it, expect, vi } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { reclaimArchivedMemberStorage, rememberStorageOwner, reclaimOwnedCheckout, pruneArchivedCheckoutStorage } from './storage-owners.js';
import { declareCornerProofOutput } from './corner-proof-output.js';

it.skipIf(process.platform !== 'linux').each(['linux', 'darwin', 'darwin-var'] as const)('ARCHIVED-OUTPUT-1 deletes closed dirty/unpushed/proof data and stops its child; preserves open and unknown (%s)', async (platform) => {
  const root = await mkdtemp(resolve(platform === 'darwin-var' ? '/var/tmp' : tmpdir(), 'beeline-closed-corner-'));
  const path = resolve(root, 'beeline/corners/' + 'f'.repeat(64));
  execFileSync('git', ['init', '-q', path]);
  await writeFile(resolve(path, 'source'), 'unpublished');
  execFileSync('git', ['-C', path, 'add', '.']);
  execFileSync('git', ['-C', path, '-c', 'user.name=Proof', '-c', 'user.email=proof@example.invalid', 'commit', '-qm', 'unpublished']);
  await writeFile(resolve(path, 'dirty'), 'discard on close');
  await declareCornerProofOutput(path, 'closed');
  const home = resolve(root, 'beeline/agents', 'a'.repeat(64), 'rooms/closed');
  await mkdir(home, { recursive: true }); await writeFile(resolve(home, 'data'), 'private');
  await rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'closed', itemId: 'f'.repeat(64), kind: 'corners', ended: true });
  const brokerScript = resolve(path, 'trusty-squire-broker.cjs');
  await writeFile(brokerScript, 'setInterval(()=>{},1000)');
  const broker = spawn(process.execPath, [brokerScript], { cwd: path, stdio: 'ignore' });
  const openRoot = resolve(root, 'beeline/corners/open');
  await mkdir(openRoot, { recursive: true });
  const openChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: openRoot, stdio: 'ignore' });
  const unrelated = spawn(process.execPath, ['-e', `/* mentions ${path}/worker.cjs */ setInterval(()=>{},1000)`], { cwd: root, stdio: 'ignore' });
  const worker = resolve(path, 'worker.cjs');
  await writeFile(worker, 'setInterval(()=>{},1000)');
  const child = spawn(process.execPath, ['-e', "process.on('message',p=>{require('fs').openSync(p,'r');process.send('ready')});setInterval(()=>{},1000)"], { cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise<void>((done, fail) => { child.once('message', () => done()); child.once('error', fail); child.send(worker); });
  const exited = new Promise<void>(done => child.once('exit', () => done()));
  await writeFile(resolve(path, '.gitignore'), 'build/\n');
  await mkdir(resolve(path, 'build'));
  await writeFile(resolve(path, 'build/output'), 'ignored output');
  const platformSpy = { mockRestore: () => vi.unstubAllGlobals() };
  vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? (platform === 'darwin-var' ? 'darwin' : platform) : Reflect.get(target, key) }));
  try {
    scans.files.length = 0; scans.argv.length = 0;
    for (const states of [[], [{ roomId: 'closed', archived: false }]]) {
      await reclaimArchivedMemberStorage(root, states);
      expect(await access(path).then(() => true, () => false)).toBe(true);
      expect(child.exitCode).toBe(null);
    }
    await reclaimOwnedCheckout(root, { workspaceId: 'workspace', roomId: 'closed', itemId: 'f'.repeat(64), kind: 'corners', ended: true });
    await pruneArchivedCheckoutStorage(root);
    expect(await access(path).then(() => true, () => false)).toBe(true);
    await reclaimArchivedMemberStorage(root, [{ roomId: 'closed', archived: true }]);
    expect(await access(path).then(() => true, () => false)).toBe(false);
    expect(await access(home).then(() => true, () => false)).toBe(false);
    if (platform !== 'linux') {
      // R-MAC-STORAGE: unrelated host processes must not each launch lsof
      // and Python while the cleanup holds the global storage lease.
      expect(scans.files.filter(args => args.includes('-u'))).toHaveLength(1);
      expect(scans.argv.filter(pids => pids.length > 1)).toHaveLength(1);
      expect(scans.files.filter(args => args.includes('-p')).length).toBeLessThanOrEqual(2);
    }
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await exited;
    expect(broker.exitCode).toBe(null);
    expect(broker.signalCode).toBe(null);
    expect(unrelated.exitCode).toBe(null);
    expect(unrelated.signalCode).toBe(null);
    expect(openChild.exitCode).toBe(null);
    expect(openChild.signalCode).toBe(null);
    expect(await access(openRoot).then(() => true, () => false)).toBe(true);
  } finally { platformSpy.mockRestore(); unrelated.kill('SIGKILL'); broker.kill('SIGKILL'); openChild.kill('SIGKILL'); child.kill('SIGKILL'); await exited; await rm(root, { recursive: true, force: true }); }
}, 30_000);


it.skipIf(process.platform !== 'linux').each(['linux', 'darwin', 'darwin-var'] as const)('ARCHIVED-OUTPUT-1 removes a home without checkout or owner and stops its child; preserves open and unknown (%s)', async (platform) => {
  const root = await mkdtemp(resolve(platform === 'darwin-var' ? '/var/tmp' : tmpdir(), 'beeline-home-only-'));
  const home = resolve(root, 'beeline/agents', 'a'.repeat(64), 'rooms/closed');
  await mkdir(home, { recursive: true });
  await writeFile(resolve(home, 'data'), 'private');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: home, stdio: 'ignore' });
  await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail); });
  const exited = new Promise<void>(done => child.once('exit', () => done()));
  vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? (platform === 'darwin-var' ? 'darwin' : platform) : Reflect.get(target, key) }));
  try {
    for (const states of [[], [{ roomId: 'closed', archived: false }]]) {
      await reclaimArchivedMemberStorage(root, states);
      expect(await access(home).then(() => true, () => false)).toBe(true);
      expect(child.exitCode).toBe(null);
      expect(child.signalCode).toBe(null);
    }
    await reclaimArchivedMemberStorage(root, [{ roomId: 'closed', archived: true }]);
    expect(await access(home).then(() => true, () => false)).toBe(false);
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await exited;
  } finally { vi.unstubAllGlobals(); child.kill('SIGKILL'); await exited; await rm(root, { recursive: true, force: true }); }
}, 30_000);

it.skipIf(process.platform !== 'linux').each(['linux', 'darwin'] as const)('ARCHIVED-OUTPUT-1 retries interrupted private repository cleanup (%s)', async (platform) => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-interrupted-'));
  const itemId = 'b'.repeat(64);
  const repo = resolve(root, 'beeline/repositories', `agent-corner-${itemId}.git`);
  execFileSync('git', ['init', '--bare', '-q', repo]);
  await rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'closed', itemId, kind: 'corners' });
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: repo, stdio: 'ignore' });
  await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail); });
  vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? platform : Reflect.get(target, key) }));
  try {
    for (const states of [[], [{ roomId: 'closed', archived: false }]]) {
      await reclaimArchivedMemberStorage(root, states);
      await pruneArchivedCheckoutStorage(root);
      await expect(access(repo)).resolves.toBeUndefined();
      expect(child.signalCode).toBe(null);
    }
    await rememberStorageOwner(root, { workspaceId: 'workspace', roomId: 'closed', itemId, kind: 'corners', archived: true });
    await pruneArchivedCheckoutStorage(root);
    expect(await access(repo).then(() => true, () => false)).toBe(false);
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    await reclaimArchivedMemberStorage(root, [{ roomId: 'closed', archived: true }]);
  } finally { vi.unstubAllGlobals(); child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
}, 30_000);
