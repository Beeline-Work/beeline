import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  harvestWarmNodeModules,
  isContainedTreePath,
  isPlanRefusal,
  missingInstalledPackages,
  nodeModulesTreePaths,
  pruneWarmStore,
  readWarmPlan,
  seedWarmNodeModules,
  sharedNpmCacheDir,
  STAGING_SWEEP_MS,
  WARM_STORE_MAX_ENTRIES,
  warmNodeModulesStoreDir,
} from './warm-node-modules.js';

/**
 * The store is proved against real files, never a mocked filesystem: the whole
 * mechanism IS filesystem behaviour — hardlinks sharing an inode, symlinks
 * surviving a clone, a rename losing a race — and a fake would only prove the
 * fake agrees with the code.
 */
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

/**
 * A second real filesystem, when this host has one. The cross-device guard
 * exists for a syscall boundary no same-device fixture can reach, so it is
 * proved where `/dev/shm` is genuinely a different device and skipped — out
 * loud — where it is not.
 */
const SECOND_FILESYSTEM = '/dev/shm';
const hasSecondFilesystem = (() => {
  try {
    return statSync(SECOND_FILESYSTEM).dev !== statSync(tmpdir()).dev;
  } catch {
    return false;
  }
})();

async function scratch(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-warm-'));
  roots.push(root);
  return root;
}

interface WorktreeSpec {
  /** Extra lockfile `packages` entries beyond the default dependencies. */
  packages?: Record<string, unknown>;
  /** Package paths recorded in npm's hidden lockfile; defaults to all of them. */
  installed?: string[];
  /** Lockfile package paths to leave UNWRITTEN, as a broken install would. */
  omit?: string[];
}

/**
 * A checkout that looks like a finished `npm ci`: a lockfile, a dependency
 * with an executable and a nested dependency, a `.bin` symlink, a workspace
 * link, npm's hidden lockfile agreeing with all of it — and a real directory
 * carrying a real `package.json` for every package the lockfile names, which
 * is the part a metadata-only completeness check could not tell apart from a
 * tree that has been gutted.
 */
async function worktree(spec: WorktreeSpec = {}): Promise<string> {
  const root = await scratch();
  const packages: Record<string, unknown> = {
    '': { name: 'fixture' },
    'node_modules/left-pad': { version: '1.0.0' },
    'node_modules/left-pad/node_modules/nested': { version: '2.0.0' },
    'packages/tool': { name: '@fixture/tool' },
    'node_modules/@fixture/tool': { link: true, resolved: 'packages/tool' },
    ...(spec.packages ?? {}),
  };
  await writeFile(resolve(root, 'package-lock.json'), JSON.stringify({ packages }));
  await mkdir(resolve(root, 'packages', 'tool'), { recursive: true });

  const omit = new Set(spec.omit ?? []);
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.includes('node_modules/')) continue;
    if ((entry as { link?: boolean }).link || omit.has(path)) continue;
    await mkdir(resolve(root, path), { recursive: true });
    await writeFile(
      resolve(root, path, 'package.json'),
      JSON.stringify({ name: path.split('/').pop(), version: '1.0.0' }),
    );
  }

  await mkdir(resolve(root, 'node_modules', '.bin'), { recursive: true });
  await mkdir(resolve(root, 'node_modules', '@fixture'), { recursive: true });
  await writeFile(resolve(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  await writeFile(resolve(root, 'node_modules', 'left-pad', 'cli.js'), '#!/usr/bin/env node\n');
  await chmod(resolve(root, 'node_modules', 'left-pad', 'cli.js'), 0o755);
  await writeFile(
    resolve(root, 'node_modules', 'left-pad', 'node_modules', 'nested', 'index.js'),
    'module.exports = 2;\n',
  );
  await symlink('../left-pad/cli.js', resolve(root, 'node_modules', '.bin', 'left-pad'));
  await symlink('../../packages/tool', resolve(root, 'node_modules', '@fixture', 'tool'));

  const installed =
    spec.installed ?? Object.keys(packages).filter((path) => path.includes('node_modules/'));
  await writeFile(
    resolve(root, 'node_modules', '.package-lock.json'),
    JSON.stringify({ packages: Object.fromEntries(installed.map((path) => [path, {}])) }),
  );
  return root;
}

describe('host-wide directories', () => {
  it('places both beside the corner pool they serve', () => {
    expect(sharedNpmCacheDir('/state')).toBe('/state/beeline/npm-cache');
    expect(warmNodeModulesStoreDir('/state')).toBe('/state/beeline/node-modules');
  });
});

describe('readWarmPlan', () => {
  it('keys identical lockfiles the same and different ones apart', async () => {
    const first = await worktree();
    const second = await worktree();
    const changed = await worktree({
      packages: { 'node_modules/right-pad': { version: '1.0.0' } },
    });
    const [a, b, c] = await Promise.all([first, second, changed].map(readWarmPlan));
    if (isPlanRefusal(a) || isPlanRefusal(b) || isPlanRefusal(c)) throw new Error('refused');
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });

  it('names every tree an install materializes, nesting excluded', async () => {
    const root = await worktree({
      packages: { 'apps/body/node_modules/dep': { version: '1.0.0' } },
    });
    const plan = await readWarmPlan(root);
    if (isPlanRefusal(plan)) throw new Error('refused');
    expect(plan.trees).toEqual(['apps/body/node_modules', 'node_modules']);
  });

  it('refuses a lockfile with no packages, and one that is not JSON', async () => {
    const empty = await scratch();
    await writeFile(resolve(empty, 'package-lock.json'), JSON.stringify({ packages: {} }));
    const broken = await scratch();
    await writeFile(resolve(broken, 'package-lock.json'), '{ not json');
    const absent = await scratch();
    for (const root of [empty, broken, absent]) {
      expect(await readWarmPlan(root)).toEqual({ failure: 'no-lockfile' });
    }
  });

  it('refuses a lockfile whose tree path escapes the checkout', async () => {
    const root = await worktree({ packages: { '../../etc/node_modules/evil': { version: '1' } } });
    expect(await readWarmPlan(root)).toEqual({
      failure: 'unsafe-lockfile',
      detail: '../../etc/node_modules',
    });
  });

  it('reads containment per path segment', () => {
    expect(isContainedTreePath('node_modules')).toBe(true);
    expect(isContainedTreePath('apps/body/node_modules')).toBe(true);
    expect(isContainedTreePath('../node_modules')).toBe(false);
    expect(isContainedTreePath('/node_modules')).toBe(false);
    expect(isContainedTreePath('a/./node_modules')).toBe(false);
    expect(isContainedTreePath('node_modules/left-pad')).toBe(false);
    expect(nodeModulesTreePaths({ 'node_modules/a/node_modules/b': {} })).toEqual(['node_modules']);
    // Whole segments only: a directory merely ending in the name is a
    // directory, and reading it as a tree would refuse the whole lockfile.
    expect(nodeModulesTreePaths({ 'vendor_node_modules/a': {}, node_modules: {} })).toEqual([]);
  });
});

describe('harvest', () => {
  it('stores a complete install and answers already-warm the second time', async () => {
    const store = await scratch();
    const source = await worktree();
    const first = await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
    expect(first.reason).toBe('stored');
    const entry = resolve(store, first.key!);
    expect((await stat(entry)).isDirectory()).toBe(true);

    const again = await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
    expect(again).toEqual({ reason: 'already-warm', key: first.key });
  });

  it('leaves the harvested checkout writable and unshared', async () => {
    const store = await scratch();
    const source = await worktree();
    const harvested = await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
    const live = resolve(source, 'node_modules', 'left-pad', 'index.js');
    const stored = resolve(store, harvested.key!, 'node_modules', 'left-pad', 'index.js');
    expect((await stat(live)).ino).not.toBe((await stat(stored)).ino);
    expect((await stat(live)).mode & 0o200).toBe(0o200);
    // The store's own copy carries no write bit, and keeps the exec bit.
    expect((await stat(stored)).mode & 0o222).toBe(0);
    expect(
      (await stat(resolve(store, harvested.key!, 'node_modules', 'left-pad', 'cli.js'))).mode &
        0o111,
    ).toBe(0o111);
  });

  it('refuses a tree missing a package the lockfile requires', async () => {
    const store = await scratch();
    const source = await worktree({
      packages: { 'node_modules/only-dev': { version: '1.0.0', dev: true } },
      installed: ['node_modules/left-pad', 'node_modules/left-pad/node_modules/nested'],
    });
    const outcome = await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
    expect(outcome.reason).toBe('incomplete');
    expect(outcome.detail).toContain('node_modules/only-dev');
    expect(
      await readWarmPlan(source).then((plan) => (isPlanRefusal(plan) ? [] : plan.trees)),
    ).toEqual(['node_modules']);
  });

  it('requires no package npm was entitled to skip', async () => {
    const store = await scratch();
    const source = await worktree({
      packages: {
        'node_modules/fsevents': { version: '1.0.0', optional: true },
        'node_modules/darwin-only': { version: '1.0.0', os: ['darwin'] },
      },
      installed: ['node_modules/left-pad', 'node_modules/left-pad/node_modules/nested'],
    });
    expect(await missingInstalledPackages(source)).toEqual([]);
    expect((await harvestWarmNodeModules({ worktreePath: source, storeRoot: store })).reason).toBe(
      'stored',
    );
  });

  it('refuses a tree whose package directory is gone but whose metadata is not', async () => {
    // The case a metadata-only check cannot see: npm's hidden lockfile still
    // claims a finished install over a tree a corner has since gutted.
    const store = await scratch();
    const source = await worktree();
    const before = await readFile(resolve(source, 'node_modules', '.package-lock.json'), 'utf8');
    await rm(resolve(source, 'node_modules', 'left-pad'), { recursive: true, force: true });
    expect(await readFile(resolve(source, 'node_modules', '.package-lock.json'), 'utf8')).toBe(
      before,
    );

    expect(await missingInstalledPackages(source)).toEqual([
      'node_modules/left-pad',
      'node_modules/left-pad/node_modules/nested',
    ]);
    const outcome = await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
    expect(outcome.reason).toBe('incomplete');
    expect(outcome.detail).toContain('node_modules/left-pad');
    expect(await readdir(store)).toEqual([]);
  });

  it('refuses a package directory that is present but empty', async () => {
    const store = await scratch();
    const source = await worktree();
    // A build that cleaned a package, or an unpack that never finished: the
    // directory survives, the package does not.
    await rm(resolve(source, 'node_modules', 'left-pad', 'package.json'));

    expect(await missingInstalledPackages(source)).toEqual(['node_modules/left-pad']);
    expect((await harvestWarmNodeModules({ worktreePath: source, storeRoot: store })).reason).toBe(
      'incomplete',
    );
    expect(await readdir(store)).toEqual([]);
  });

  it('refuses a copy that lost a package after its checkout was cleared', async () => {
    const store = await scratch();
    const source = await worktree();
    const outcome = await harvestWarmNodeModules({
      worktreePath: source,
      storeRoot: store,
      // Gut the STAGED copy, leaving the checkout it was read from intact:
      // the bytes about to be published are what must be complete.
      onCopied: async () => {
        const staging = (await readdir(store)).find((name) => name.startsWith('.beeline-warm-'));
        await rm(resolve(store, staging!, 'node_modules', 'left-pad'), {
          recursive: true,
          force: true,
        });
      },
    });
    expect(outcome.reason).toBe('changed');
    expect(await readdir(store)).toEqual([]);
  });

  it('refuses a checkout with no hidden lockfile at all', async () => {
    const store = await scratch();
    const source = await worktree();
    await rm(resolve(source, 'node_modules', '.package-lock.json'));
    const outcome = await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
    expect(outcome.reason).toBe('incomplete');
    expect(outcome.detail).toContain('.package-lock.json is absent');
  });

  it('refuses a checkout missing one of the trees its lockfile names', async () => {
    const store = await scratch();
    const source = await worktree({
      packages: { 'apps/body/node_modules/dep': { version: '1.0.0' } },
      omit: ['apps/body/node_modules/dep'],
    });
    const outcome = await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
    expect(outcome).toMatchObject({ reason: 'no-node-modules', detail: 'apps/body/node_modules' });
  });

  it('stores nothing when the checkout moved under the copy', async () => {
    const store = await scratch();
    const source = await worktree();
    const hidden = resolve(source, 'node_modules', '.package-lock.json');
    // The next turn's install, landing while the copy is in flight: npm
    // rewrites the hidden lockfile, so the staged copy no longer matches.
    const outcome = await harvestWarmNodeModules({
      worktreePath: source,
      storeRoot: store,
      onCopied: () => writeFile(hidden, JSON.stringify({ packages: { 'node_modules/x': {} } })),
    });
    expect(outcome.reason).toBe('changed');
    expect(await readdir(store)).toEqual([]);
  });

  it('keeps the store bounded, dropping the least recently used entries', async () => {
    const store = await scratch();
    // Older than anything a harvest will write, and ordered among themselves.
    const olds = ['aaa', 'bbb', 'ccc'].map((name) => resolve(store, name));
    for (const [index, old] of olds.entries()) {
      await mkdir(old, { recursive: true });
      const when = (Date.now() - (olds.length - index) * 60_000) / 1000;
      await utimes(old, when, when);
    }
    const source = await worktree();
    const stored = await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
    expect(stored.reason).toBe('stored');

    const kept = (await readdir(store)).sort();
    expect(kept).toHaveLength(WARM_STORE_MAX_ENTRIES);
    // The new entry and the two most recently used, never the oldest.
    expect(kept).toContain(stored.key);
    expect(kept).toContain('ccc');
    expect(kept).not.toContain('aaa');
  });

  it('promotes an entry when a worktree is seeded from it', async () => {
    const store = await scratch();
    const source = await worktree();
    const stored = await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
    const aged = (Date.now() - 60 * 60_000) / 1000;
    await utimes(resolve(store, stored.key!), aged, aged);

    const fresh = await scratch();
    await writeFile(
      resolve(fresh, 'package-lock.json'),
      await readFile(resolve(source, 'package-lock.json'), 'utf8'),
    );
    await seedWarmNodeModules({ worktreePath: fresh, storeRoot: store });

    // Used is used: a seed refreshes recency, so the entry every new corner is
    // being cut from is never the one a prune chooses.
    expect((await stat(resolve(store, stored.key!))).mtimeMs).toBeGreaterThan(aged * 1000);
    expect(await pruneWarmStore(store, 1)).toEqual([]);
  });

  it('sweeps staging left by a process that died, and keeps a fresh one', async () => {
    const store = await scratch();
    const stale = resolve(store, '.beeline-warm-1.dead');
    const fresh = resolve(store, '.beeline-warm-2.live');
    await mkdir(stale, { recursive: true });
    await mkdir(fresh, { recursive: true });
    const aged = (Date.now() - STAGING_SWEEP_MS - 60_000) / 1000;
    await utimes(stale, aged, aged);
    const source = await worktree();
    await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
    await expect(stat(stale)).rejects.toThrow();
    // Swept by age, so a staging directory younger than the window survives —
    // it may belong to a sibling daemon mid-clone.
    expect((await stat(fresh)).isDirectory()).toBe(true);
  });
});

describe('seed', () => {
  it('hardlinks a stored tree into a new checkout', async () => {
    const store = await scratch();
    const source = await worktree({
      packages: { 'apps/body/node_modules/dep': { version: '1.0.0' } },
    });
    const harvested = await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
    expect(harvested.reason).toBe('stored');

    // A brand-new corner worktree: the same lockfile, nothing installed.
    const fresh = await scratch();
    await writeFile(
      resolve(fresh, 'package-lock.json'),
      await readFile(resolve(source, 'package-lock.json'), 'utf8'),
    );
    const seeded = await seedWarmNodeModules({ worktreePath: fresh, storeRoot: store });
    expect(seeded).toEqual({ reason: 'seeded', key: harvested.key });

    const stored = resolve(store, harvested.key!, 'node_modules', 'left-pad', 'index.js');
    const linked = resolve(fresh, 'node_modules', 'left-pad', 'index.js');
    expect((await stat(linked)).ino).toBe((await stat(stored)).ino);
    expect(await readFile(linked, 'utf8')).toBe('module.exports = 1;\n');
    // Every tree the lockfile names, not only the root one.
    expect(
      JSON.parse(await readFile(resolve(fresh, 'apps/body/node_modules/dep/package.json'), 'utf8')),
    ).toMatchObject({ name: 'dep' });
    // Symlinks are reproduced as symlinks, with their targets intact.
    expect(await readlink(resolve(fresh, 'node_modules', '.bin', 'left-pad'))).toBe(
      '../left-pad/cli.js',
    );
    expect(await readlink(resolve(fresh, 'node_modules', '@fixture', 'tool'))).toBe(
      '../../packages/tool',
    );
    // Nothing staged is left in the store or the checkout.
    expect((await lstat(fresh).then(() => true)) && (await hasStaging(store))).toBe(false);
    expect(await hasStaging(fresh)).toBe(false);
  });

  it('gives npm back a writable hidden lockfile, not a shared one', async () => {
    const store = await scratch();
    const source = await worktree();
    const harvested = await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
    const fresh = await scratch();
    await writeFile(
      resolve(fresh, 'package-lock.json'),
      await readFile(resolve(source, 'package-lock.json'), 'utf8'),
    );
    await seedWarmNodeModules({ worktreePath: fresh, storeRoot: store });

    const hidden = resolve(fresh, 'node_modules', '.package-lock.json');
    const stored = resolve(store, harvested.key!, 'node_modules', '.package-lock.json');
    expect((await stat(hidden)).ino).not.toBe((await stat(stored)).ino);
    // npm rewrites this file in place on every install; it must not be
    // read-only and must not be the store's inode.
    await writeFile(hidden, '{"packages":{}}');
    expect(await readFile(stored, 'utf8')).not.toBe('{"packages":{}}');
  });

  it('leaves an existing install alone and reports a cold store honestly', async () => {
    const store = await scratch();
    const populated = await worktree();
    expect(await seedWarmNodeModules({ worktreePath: populated, storeRoot: store })).toMatchObject({
      reason: 'present',
    });

    const bare = await scratch();
    await writeFile(
      resolve(bare, 'package-lock.json'),
      await readFile(resolve(populated, 'package-lock.json'), 'utf8'),
    );
    expect(await seedWarmNodeModules({ worktreePath: bare, storeRoot: store })).toMatchObject({
      reason: 'cold',
    });
    expect(await hasStaging(bare)).toBe(false);
  });

  it.skipIf(!hasSecondFilesystem)(
    'declines a store on another filesystem instead of linking into a failed rename',
    async () => {
      const store = await mkdtemp(resolve(SECOND_FILESYSTEM, 'beeline-warm-'));
      const source = await worktree();
      const harvested = await harvestWarmNodeModules({ worktreePath: source, storeRoot: store });
      const fresh = await scratch();
      await writeFile(
        resolve(fresh, 'package-lock.json'),
        await readFile(resolve(source, 'package-lock.json'), 'utf8'),
      );
      try {
        expect((await stat(store)).dev).not.toBe((await stat(fresh)).dev);
        expect(await seedWarmNodeModules({ worktreePath: fresh, storeRoot: store })).toEqual({
          reason: 'cross-device',
          key: harvested.key,
        });
        expect(await hasStaging(store)).toBe(false);
      } finally {
        await rm(store, { recursive: true, force: true });
      }
    },
  );

  it('says no-lockfile for a checkout npm does not own', async () => {
    const store = await scratch();
    const root = await scratch();
    expect(await seedWarmNodeModules({ worktreePath: root, storeRoot: store })).toEqual({
      reason: 'no-lockfile',
    });
    expect(await harvestWarmNodeModules({ worktreePath: root, storeRoot: store })).toEqual({
      reason: 'no-lockfile',
    });
  });

  it('refuses to write through a lockfile path that escapes the checkout', async () => {
    const store = await scratch();
    const root = await worktree({ packages: { '../node_modules/evil': { version: '1' } } });
    expect(await seedWarmNodeModules({ worktreePath: root, storeRoot: store })).toMatchObject({
      reason: 'unsafe-lockfile',
    });
    expect(await harvestWarmNodeModules({ worktreePath: root, storeRoot: store })).toMatchObject({
      reason: 'unsafe-lockfile',
    });
  });
});

async function hasStaging(root: string): Promise<boolean> {
  const entries = await readdir(root).catch(() => [] as string[]);
  return entries.some((entry) => entry.startsWith('.beeline-warm-'));
}
