import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, link, lstat, lutimes, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capturePrivateProcessUse, STORAGE_ITEM_UNUSED_MS, reclaimHelperStorage } from './helper-storage.js';
import { SessionScheduler } from './session-scheduler.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'beeline-storage-'));
  roots.push(runtimeDir);
  const root = join(runtimeDir, 'rooms/room-a');
  async function file(path: string, text = 'keep or reclaim') {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
    return target;
  }
  const readStates = async () => [{ roomId: 'room-a', archived: false }];
  const withIdleRoom = async (_id: string, task: () => Promise<void>) => { await task(); return true; };
  const inUse = async () => false;
  return { runtimeDir, root, file, input: { runtimeDir, readStates, withIdleRoom, inUse } };
}
const exists = (path: string) => access(path).then(() => true, () => false);

async function age(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory()) for (const entry of await readdir(path)) await age(join(path, entry));
  if (!info.isSymbolicLink()) {
    const old = new Date(Date.now() - STORAGE_ITEM_UNUSED_MS - 86_400_000);
    await utimes(path, old, old);
  }
}

describe('helper private storage reclamation', () => {
  it('requires affirmative lifecycle; an open item qualifies only when every descendant has been unused for seven days', async () => {
    const f = await fixture();
    const cache = await f.file('agent-home/cache/stale-download');
    await age(dirname(cache));
    for (const readStates of [async () => [], async () => { throw new Error('server unreachable'); }]) {
      expect(await reclaimHelperStorage({ ...f.input, readStates })).toEqual([]);
      expect(await exists(cache)).toBe(true);
    }
    const fresh = await f.file('agent-home/cache/newly-used');
    expect(await reclaimHelperStorage(f.input)).toEqual([]);
    expect(await exists(cache)).toBe(true);
    await age(dirname(cache));
    expect(await reclaimHelperStorage(f.input)).toHaveLength(1);
    expect(await exists(cache)).toBe(false);
    expect(await exists(fresh)).toBe(false);
  });

  it('reclaims unused whole caches, tmp, inactive AVDs and builds; keeps recent work, logins, browser profiles, settings, history and resume databases', async () => {
    const f = await fixture();
    const disposable = [
      'agent-home/cache/tiny-fresh-cache', 'agent-home/user/.gradle/caches/old-tool',
      'agent-home/tmp/fresh-delivery', 'scratch/agent-home/android-instances/instance/data',
      'agent-home/user/.android/avd/device.avd/snapshot', 'aab-build/app.aab',
      'agent-home/codex/logs_2.sqlite', 'agent-home/codex/skills/managed/SKILL.md',
    ];
    const retained = [
      'agent-home/codex/sessions/rollout.jsonl', 'agent-home/codex/state_5.sqlite',
      'agent-home/codex/thread_history_1.sqlite-wal', 'agent-home/codex/session_index.jsonl',
      'scratch/agent-home/claude/projects/project/subagents/transcript.jsonl',
      'agent-home/pi/sessions/chat.jsonl', 'agent-home/user/.pi/pi-acp/session-map.json',
      'agent-home/goose/data/sessions/sessions.db', 'agent-home/goose/state/session',
      'agent-home/user/.local/share/opencode/opencode.db-wal',
      'agent-home/codex/auth.json', 'agent-home/codex/config.toml',
      'agent-home/pi/settings.json', 'agent-home/pi/mcp.json', 'agent-home/pi/models.json',
      'agent-home/claude/.claude.json', 'agent-home/state/gh/hosts.yml', '.expo/settings.json',
      'agent-home/user/.trusty-squire/unknown-store', 'scratch/video.mp4', 'notes.txt',
      'agent-home/beeline-github-bin/attachments/photo.jpg', 'agent-home/user/.android/adbkey',
      'agent-home/user/.local/share/cursor-agent/install/tool',
      'agent-home/user/.trusty-squire/chrome-profile/Default/Cookies',
    ];
    for (const path of [...disposable, ...retained]) await f.file(path);
    for (const path of disposable) {
      // Age each whole object, after its contents have been created.
      const target = path.endsWith('.sqlite') ? join(f.root, path) : dirname(join(f.root, path));
      await age(target);
    }
    // Old protected data must survive too.
    await age(join(f.root, 'agent-home/codex/skills'));
    await age(join(f.root, 'agent-home/codex/sessions'));
    await age(join(f.root, 'agent-home/user/.trusty-squire/chrome-profile'));
    const unknown = vi.fn();
    const entries = await reclaimHelperStorage({ ...f.input, unknown });
    expect(entries.every(entry => entry.kind === 'open')).toBe(true);
    expect(entries.some(entry => entry.path === join(f.root, 'agent-home/cache'))).toBe(true);
    for (const path of disposable) expect(await exists(join(f.root, path)), path).toBe(false);
    for (const path of retained) expect(await exists(join(f.root, path)), path).toBe(true);
    expect(unknown).toHaveBeenCalledWith('room-a', join(f.root, 'scratch/video.mp4'));
  });

  it('archive immediately removes the entire private folder including local conversations/resume state, but never shared corners/', async () => {
    const f = await fixture();
    const history = await f.file('scratch/agent-home/codex/sessions/rollout.jsonl');
    const resume = await f.file('agent-home/user/.pi/pi-acp/session-map.json');
    const approval = await f.file('scratch/agent-private/approval.json');
    const handmade = await f.file('handmade-script.sh');
    const settings = await f.file('agent-home/pi/settings.json');
    const shared = join(f.runtimeDir, 'corners/room-a');
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'unpublished.ts'), 'unpublished');
    const entries = await reclaimHelperStorage({ ...f.input, readStates: async () => [{ roomId: 'room-a', archived: true }] });
    expect(entries.length).toBeGreaterThan(0);
    expect(await exists(history)).toBe(false);
    expect(await exists(resume)).toBe(false);
    expect(await exists(f.root)).toBe(false);
    for (const path of [approval, handmade, settings]) expect(await exists(path)).toBe(false);
    expect(await readFile(join(shared, 'unpublished.ts'), 'utf8')).toBe('unpublished');
  });

  it('uses the newest atime OR mtime in a whole unknown work object, and dry run leaves access dates unchanged', async () => {
    const f = await fixture();
    const handmade = await f.file('scratch/handmade/video.mp4');
    await age(join(f.root, 'scratch/handmade'));
    const old = new Date(Date.now() - STORAGE_ITEM_UNUSED_MS - 86_400_000);
    await utimes(handmade, new Date(), old);
    expect(await reclaimHelperStorage(f.input)).toEqual([]);
    await age(join(f.root, 'scratch/handmade'));
    const before = await lstat(join(f.root, 'scratch/handmade'));
    const entries = await reclaimHelperStorage({ ...f.input, dryRun: true });
    expect(entries).toHaveLength(1);
    expect((await lstat(join(f.root, 'scratch/handmade'))).atimeMs).toBe(before.atimeMs);
    expect(await exists(handmade)).toBe(true);
    await reclaimHelperStorage(f.input);
    expect(await exists(join(f.root, 'scratch/handmade'))).toBe(false);
  });

  it('refuses a running turn, retained process, orphan process or emulator lease', async () => {
    const f = await fixture();
    const file = await f.file('agent-home/tmp/fresh');
    expect(await reclaimHelperStorage({ ...f.input, withIdleRoom: async () => false })).toEqual([]);
    expect(await reclaimHelperStorage({ ...f.input, inUse: async () => true })).toEqual([]);
    const leaseRoot = join(f.runtimeDir, 'leases');
    await mkdir(leaseRoot);
    await writeFile(join(leaseRoot, 'port-5554.lease'), `123:456:lease:${f.root}/agent-home/android-instances/instance`);
    expect(await reclaimHelperStorage({ ...f.input, emulatorLeaseRoot: leaseRoot })).toEqual([]);
    expect(await exists(file)).toBe(true);
  });

  it('dry run never deletes or writes back credentials and reports hardlink-aware allocated bytes', async () => {
    const f = await fixture();
    const shared = await f.file('agent-home/cache/file', 'shared inode');
    await link(shared, join(f.runtimeDir, 'external-hardlink'));
    const detached = await f.file('agent-home/claude/.credentials.json', 'detached');
    const before = await lstat(shared);
    const log = vi.fn();
    const entries = await reclaimHelperStorage({ ...f.input, dryRun: true, log, readStates: async () => [{ roomId: 'room-a', archived: true }] });
    const entry = entries.find(item => item.path === f.root)!;
    expect(entry.allocatedBytes - entry.freedBytes).toBe(before.blocks * 512);
    expect(log).toHaveBeenCalled();
    expect(await readFile(detached, 'utf8')).toBe('detached');
    expect(await exists(shared)).toBe(true);
  });

  it('rm unlinks a login symlink and cache-internal directory symlinks without following them into the operator home', async () => {
    const f = await fixture();
    const operator = join(f.runtimeDir, 'operator');
    await mkdir(operator);
    const login = join(operator, 'auth.json');
    await writeFile(login, 'operator-login');
    await f.file('agent-home/cache/download');
    await mkdir(join(f.root, 'agent-home/codex'), { recursive: true });
    await symlink(login, join(f.root, 'agent-home/codex/auth.json'));
    await symlink(operator, join(f.root, 'agent-home/cache/operator-dir'));
    await reclaimHelperStorage({ ...f.input, operatorHome: operator, readStates: async () => [{ roomId: 'room-a', archived: true }] });
    expect(await readFile(login, 'utf8')).toBe('operator-login');
    expect(await lstat(join(f.root, 'agent-home/codex/auth.json')).catch(() => undefined)).toBeUndefined();
  });

  it('writes a newer detached Claude login back before archive removal and defers when the shared lock is busy', async () => {
    const f = await fixture();
    const operator = join(f.runtimeDir, 'operator');
    await mkdir(join(operator, '.claude'), { recursive: true });
    const source = join(operator, '.claude/.credentials.json');
    const login = (expiresAt: number) => JSON.stringify({ claudeAiOauth: { expiresAt, refreshToken: `test-${expiresAt}` } });
    await writeFile(source, login(10));
    const target = await f.file('agent-home/claude/.credentials.json', login(20));
    await f.file('agent-home/tmp/fresh');
    const input = { ...f.input, operatorHome: operator, readStates: async () => [{ roomId: 'room-a', archived: true }] };
    await writeFile(`${source}.beeline-lock`, 'test-lock');
    expect(await reclaimHelperStorage(input)).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe(login(20));
    await rm(`${source}.beeline-lock`);
    await reclaimHelperStorage(input);
    expect(await readFile(source, 'utf8')).toBe(login(20));
    expect(await exists(target)).toBe(false);
  });

  it('counts only successful removal and continues after an item cannot be deleted', async () => {
    const f = await fixture();
    await f.file('agent-home/tmp/stale');
    await age(join(f.root, 'agent-home/tmp'));
    const parent = join(f.root, 'agent-home');
    await chmod(parent, 0o555);
    const log = vi.fn();
    const onError = vi.fn();
    try {
      expect(await reclaimHelperStorage({ ...f.input, log, onError })).toEqual([]);
      expect(log).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledOnce();
    } finally { await chmod(parent, 0o755); }
  });

  it('counts a shared inode once when its last link across two whole items is removed', async () => {
    const f = await fixture();
    const first = await f.file('a.bin', 'one inode');
    await link(first, join(f.root, 'b.bin'));
    await age(first);
    const bytes = (await lstat(first)).blocks * 512;
    const dry = await reclaimHelperStorage({ ...f.input, dryRun: true });
    expect(dry.reduce((sum, entry) => sum + entry.freedBytes, 0)).toBe(bytes);
    const actual = await reclaimHelperStorage(f.input);
    expect(actual.reduce((sum, entry) => sum + entry.freedBytes, 0)).toBe(bytes);
  });

  it('treats a disposable SQLite database and its journals as one object', async () => {
    const f = await fixture();
    const database = await f.file('agent-home/codex/logs_2.sqlite');
    await age(database);
    const wal = await f.file('agent-home/codex/logs_2.sqlite-wal');
    expect(await reclaimHelperStorage(f.input)).toEqual([]);
    await age(wal);
    const entries = await reclaimHelperStorage(f.input);
    expect(entries).toHaveLength(1);
    expect(await exists(database)).toBe(false);
    expect(await exists(wal)).toBe(false);
  });

  it('rejects a symlinked Room directory and a symlinked rooms ancestor', async () => {
    const f = await fixture();
    const file = await f.file('agent-home/tmp/file');
    await symlink(f.root, join(f.runtimeDir, 'rooms/room-link'));
    expect(await reclaimHelperStorage({ ...f.input, readStates: async () => [{ roomId: 'room-link', archived: true }] })).toEqual([]);
    await mkdir(join(f.runtimeDir, 'linked-runtime'));
    await symlink(join(f.runtimeDir, 'rooms'), join(f.runtimeDir, 'linked-runtime/rooms'));
    expect(await reclaimHelperStorage({ ...f.input, runtimeDir: join(f.runtimeDir, 'linked-runtime') })).toEqual([]);
    expect(await exists(file)).toBe(true);
  });

  it('detects a detached child from its private cwd even without a running turn', async () => {
    const f = await fixture();
    await f.file('agent-home/tmp/file');
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { cwd: f.root, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await once(child.stdout!, 'data');
      expect((await capturePrivateProcessUse())(f.root)).toBe(true);
    } finally {
      child.kill();
      await once(child, 'exit');
    }
  });

  it('scheduler lease refuses retained/spawning sessions and fences a new turn until deletion finishes', async () => {
    const scheduler = new SessionScheduler({ maxLiveSessions: 1 });
    let release!: () => void;
    const hold = new Promise<void>(done => { release = done; });
    const activate = vi.fn(async () => 'physical');
    const lifecycle = { activate, suspend: async () => undefined };
    try {
      const maintenance = scheduler.withIdleStorage('room', async () => hold);
      const turn = scheduler.run('room', lifecycle, async () => 'reply');
      expect(activate).not.toHaveBeenCalled();
      release();
      expect(await maintenance).toBe(true);
      expect(await turn).toBe('reply');
      expect(await scheduler.withIdleStorage('room', async () => undefined)).toBe(false);
      await scheduler.suspend('room');
      expect(await scheduler.withIdleStorage('room', async () => undefined)).toBe(true);
    } finally { await scheduler.dispose(); }
  });
});

it('hard-excludes every Squire store for both open and ended owners, and never follows an external store link', async () => {
  const f = await fixture();
  const stores = ['agent-home/user/.trusty-squire', 'squire-host-config', 'scratch/agent-home/user/.config/trusty-squire'];
  for (const store of stores) await f.file(`${store}/vault`, 'untouchable');
  const disposable = await f.file('agent-home/cache/stale');
  await age(dirname(disposable));
  await reclaimHelperStorage(f.input);
  expect(await exists(disposable)).toBe(false);
  await reclaimHelperStorage({ ...f.input, readStates: async () => [{ roomId: 'room-a', archived: true }] });
  for (const store of stores) expect(await readFile(join(f.root, store, 'vault'), 'utf8')).toBe('untouchable');
});

it('fences new turns across all hosted agents during shared-cache cleanup', async () => {
  const a = new SessionScheduler();
  const b = new SessionScheduler();
  const activate = vi.fn(async () => 'session');
  let release!: () => void;
  const hold = new Promise<void>(done => { release = done; });
  try {
    const sweep = SessionScheduler.withIdleHostStorage(async () => hold);
    const turn = b.run('room', { activate, suspend: async () => undefined }, async () => 'done');
    expect(activate).not.toHaveBeenCalled();
    release();
    expect(await sweep).toBe(true);
    expect(await turn).toBe('done');
    expect(await SessionScheduler.withIdleHostStorage(async () => undefined)).toBe(false);
  } finally { release(); await a.dispose(); await b.dispose(); }
});


it('preserves old package/cloud/signing credentials and keeps a cache whole when it contains a login', async () => {
  const f = await fixture();
  const credentials = ['user/.m2/settings.xml', 'user/.m2/settings-security.xml', 'user/.docker/config.json',
    'user/.yarnrc.yml', 'user/.android/debug.keystore', 'user/.cache/huggingface/token'];
  for (const path of credentials) await f.file(`agent-home/${path}`, 'credential');
  const cache = await f.file('agent-home/user/.cache/downloads/tool');
  await age(f.root);
  await reclaimHelperStorage(f.input);
  for (const path of credentials) expect(await exists(join(f.root, 'agent-home', path)), path).toBe(true);
  expect(await exists(cache)).toBe(true); // Atomic cache: preserve the complete item, never carve out its token.
});


it('keeps old harness and config directory aliases whose sign-in/history children are outside the no-follow inventory', async () => {
  const f = await fixture();
  const external = join(f.runtimeDir, 'operator-state');
  await mkdir(join(external, 'codex/sessions'), { recursive: true });
  await mkdir(join(external, 'config/cursor'), { recursive: true });
  await writeFile(join(external, 'codex/auth.json'), 'operator login');
  await writeFile(join(external, 'codex/sessions/thread'), 'operator history');
  await writeFile(join(external, 'config/cursor/auth.json'), 'operator login');
  await f.file('agent-home/user/marker');
  const aliases = [join(f.root, 'agent-home/codex'), join(f.root, 'agent-home/user/.config')];
  await symlink(join(external, 'codex'), aliases[0]!);
  await symlink(join(external, 'config'), aliases[1]!);
  const old = new Date(Date.now() - 8 * 86400_000);
  for (const alias of aliases) await lutimes(alias, old, old);
  await reclaimHelperStorage(f.input);
  for (const alias of aliases) expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  expect(await readFile(join(aliases[0]!, 'sessions/thread'), 'utf8')).toBe('operator history');
});
