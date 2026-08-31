import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectLocalRepository, type AgentRuntimeRecord } from './runtime.js';
import { migrateLegacyRepositoryPaths, RepositoryTruthResolver } from './repository-truth.js';
import { repositoryDirectoryName } from './repository-path.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

function fixture(): {
  root: string;
  origin: string;
  operator: string;
  binding: ReturnType<typeof inspectLocalRepository>;
} {
  const root = mkdtempSync(join(tmpdir(), 'beeline-repository-truth-'));
  cleanup.push(root);
  const origin = resolve(root, 'origin.git');
  const seed = resolve(root, 'seed');
  const operator = resolve(root, 'operator');
  git(root, ['init', '--bare', '-q', origin]);
  git(root, ['clone', '-q', origin, seed]);
  git(seed, ['config', 'user.name', 'Seed']);
  git(seed, ['config', 'user.email', 'seed@example.invalid']);
  writeFileSync(resolve(seed, 'README.md'), 'remote truth\n');
  git(seed, ['add', 'README.md']);
  git(seed, ['commit', '-qm', 'seed']);
  git(seed, ['branch', '-M', 'main']);
  git(seed, ['push', '-q', '-u', 'origin', 'main']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['clone', '-q', origin, operator]);
  return { root, origin, operator, binding: inspectLocalRepository(operator) };
}

describe('one repository-truth resolver', () => {
  it('uses a collision-resistant PATH-safe directory for an unsafe repository key', () => {
    const root = mkdtempSync(join(tmpdir(), 'beeline-repository-path-'));
    cleanup.push(root);
    const resolver = new RepositoryTruthResolver({ repositoriesRoot: root });
    const checkout = resolver.checkoutPath('github:1330313701');

    expect(checkout).toBe(resolve(root, repositoryDirectoryName('github:1330313701')));
    expect(checkout).not.toMatch(/[:\s]/);
    expect(checkout).not.toBe(resolver.checkoutPath('github-1330313701'));
  });

  it('keeps an unmigratable legacy checkout reachable through the compatibility resolver', () => {
    const root = mkdtempSync(join(tmpdir(), 'beeline-repository-compat-'));
    cleanup.push(root);
    const legacy = resolve(root, 'github:1330313701');
    const current = resolve(root, repositoryDirectoryName('github:1330313701'));
    mkdirSync(legacy, { recursive: true });
    mkdirSync(current, { recursive: true });

    const resolver = new RepositoryTruthResolver({ repositoriesRoot: root });
    expect(resolver.checkoutPath('github:1330313701')).toBe(legacy);
  });

  it('migrates a legacy checkout, preserves linked corners, repairs Git, and rewrites runtime paths', async () => {
    const supervisorRoot = mkdtempSync(join(tmpdir(), 'beeline-repository-migration-'));
    cleanup.push(supervisorRoot);
    const repositoriesRoot = resolve(supervisorRoot, 'beeline', 'repositories');
    const repositoryKey = 'github:1330313701';
    const legacyCheckout = resolve(repositoriesRoot, repositoryKey);
    const currentCheckout = resolve(repositoriesRoot, repositoryDirectoryName(repositoryKey));
    const legacyCorner = resolve(repositoriesRoot, '.beeline-corners', repositoryKey, 'corner-1');
    mkdirSync(repositoriesRoot, { recursive: true });
    git(repositoriesRoot, ['init', '-q', '-b', 'main', legacyCheckout]);
    git(legacyCheckout, ['config', 'user.name', 'Migration']);
    git(legacyCheckout, ['config', 'user.email', 'migration@example.invalid']);
    git(legacyCheckout, ['commit', '-q', '--allow-empty', '-m', 'seed']);
    mkdirSync(resolve(legacyCorner, '..'), { recursive: true });
    git(legacyCheckout, ['worktree', 'add', '-q', '-b', 'feature/corner-1', legacyCorner, 'main']);
    const orphanKey = 'github:orphan-cache';
    const orphanLegacy = resolve(repositoriesRoot, orphanKey);
    const orphanCurrent = resolve(repositoriesRoot, repositoryDirectoryName(orphanKey));
    git(repositoriesRoot, ['init', '-q', '-b', 'main', orphanLegacy]);

    const runtime: AgentRuntimeRecord = {
      version: 2,
      communityId: '11111111-1111-4111-8111-111111111111',
      pairedBy: 'c'.repeat(64),
      agent: { name: 'Agent', secretKeyHex: '1'.repeat(64), publicKey: 'a'.repeat(64) },
      body: { name: 'Body', secretKeyHex: '2'.repeat(64), publicKey: 'b'.repeat(64) },
      rooms: [
        {
          channelId: 'room-1',
          repo: {
            root: legacyCheckout,
            gitCommonDir: resolve(legacyCheckout, '.git'),
            targetBranch: 'main',
            repository: { key: repositoryKey, name: 'example', localOnly: true },
          },
          membershipSince: 1,
          discoveredAt: new Date(0).toISOString(),
        },
      ],
      supervisorRoot,
      relayBaseUrl: 'http://relay.test',
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
      createdAt: new Date(0).toISOString(),
    };

    const result = await migrateLegacyRepositoryPaths(runtime, { log: () => undefined });

    expect(result.migrated).toBe(2);
    expect(existsSync(legacyCheckout)).toBe(false);
    expect(existsSync(legacyCorner)).toBe(true);
    expect(existsSync(currentCheckout)).toBe(true);
    expect(git(legacyCorner, ['rev-parse', '--show-toplevel'])).toBe(legacyCorner);
    expect(git(currentCheckout, ['worktree', 'list', '--porcelain'])).toContain(
      `worktree ${legacyCorner}`,
    );
    expect(existsSync(orphanLegacy)).toBe(false);
    expect(existsSync(orphanCurrent)).toBe(true);
    expect(result.runtime.rooms[0]!.repo.root).toBe(currentCheckout);
    expect(result.runtime.rooms[0]!.repo.gitCommonDir).toBe(resolve(currentCheckout, '.git'));
    const configPath = resolve(
      supervisorRoot,
      'beeline',
      'agents',
      runtime.agent.publicKey,
      'runtime.json',
    );
    const stored = JSON.parse(readFileSync(configPath, 'utf8')) as AgentRuntimeRecord;
    expect(stored.rooms[0]!.repo.root).toBe(currentCheckout);
    expect(stored.rooms[0]!.repo.gitCommonDir).toBe(resolve(currentCheckout, '.git'));
  });

  it('treats a remote as truth and refreshes the canonical cache before a corner opens', async () => {
    const f = fixture();
    const resolver = new RepositoryTruthResolver({
      repositoriesRoot: resolve(f.root, 'canonical'),
    });
    const joined = await resolver.resolve(f.binding, 'room-join');
    expect(joined.kind).toBe('remote');
    expect(joined.checkoutPath).not.toBe(f.operator);
    expect(git(joined.checkoutPath, ['show', 'HEAD:README.md'])).toBe('remote truth');

    const writer = resolve(f.root, 'writer');
    git(f.root, ['clone', '-q', f.origin, writer]);
    git(writer, ['config', 'user.name', 'Writer']);
    git(writer, ['config', 'user.email', 'writer@example.invalid']);
    writeFileSync(resolve(writer, 'AFTER.txt'), 'new true tip\n');
    git(writer, ['add', 'AFTER.txt']);
    git(writer, ['commit', '-qm', 'advance origin']);
    git(writer, ['push', '-q', 'origin', 'main']);
    const remoteTip = git(writer, ['rev-parse', 'HEAD']);

    const corner = await resolver.resolve(f.binding, 'corner-open');
    expect(git(corner.checkoutPath, ['rev-parse', 'HEAD'])).toBe(remoteTip);
  });

  it('serializes canonical refreshes from separate daemon-side resolver instances', async () => {
    const f = fixture();
    const repositoriesRoot = resolve(f.root, 'canonical');
    await new RepositoryTruthResolver({ repositoriesRoot }).resolve(f.binding, 'room-join');

    let releaseFirstFetch!: () => void;
    const firstFetchReleased = new Promise<void>((resolveRelease) => {
      releaseFirstFetch = resolveRelease;
    });
    let signalFirstFetch!: () => void;
    const firstFetchEntered = new Promise<void>((resolveEntered) => {
      signalFirstFetch = resolveEntered;
    });
    let fetchCalls = 0;
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const runRemoteGit = async (cwd: string, args: string[]) => {
      if (args[0] === 'fetch') {
        fetchCalls += 1;
        activeFetches += 1;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        if (fetchCalls === 1) {
          signalFirstFetch();
          await firstFetchReleased;
        }
      }
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (args[0] === 'fetch') activeFetches -= 1;
      return {
        ok: result.status === 0,
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    };
    const first = new RepositoryTruthResolver({ repositoriesRoot, runRemoteGit });
    const second = new RepositoryTruthResolver({ repositoriesRoot, runRemoteGit });

    const firstRefresh = first.resolve(f.binding, 'room-join');
    await firstFetchEntered;
    const secondRefresh = second.resolve(f.binding, 'room-join');
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));

    expect(fetchCalls).toBe(1);
    expect(maxActiveFetches).toBe(1);
    releaseFirstFetch();
    await Promise.all([firstRefresh, secondRefresh]);
    expect(fetchCalls).toBe(2);
    expect(maxActiveFetches).toBe(1);
  });

  it('recovers a canonical checkout lock whose daemon owner exited', async () => {
    const f = fixture();
    const repositoriesRoot = resolve(f.root, 'canonical');
    const lock = resolve(
      repositoriesRoot,
      '.beeline-locks',
      `${repositoryDirectoryName(f.binding.repository.key)}.lock`,
    );
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      resolve(lock, 'owner.json'),
      JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner', acquiredAt: Date.now() }),
    );

    const truth = await new RepositoryTruthResolver({ repositoriesRoot }).resolve(
      f.binding,
      'room-join',
    );

    expect(truth.kind).toBe('remote');
    expect(existsSync(lock)).toBe(false);
  });

  it('declares a local-only checkout itself as truth without falling back elsewhere', async () => {
    const root = mkdtempSync(join(tmpdir(), 'beeline-local-truth-'));
    cleanup.push(root);
    const operator = resolve(root, 'operator');
    git(root, ['init', '-q', operator]);
    git(operator, ['config', 'user.name', 'Local']);
    git(operator, ['config', 'user.email', 'local@example.invalid']);
    writeFileSync(resolve(operator, 'README.md'), 'local committed truth\n');
    git(operator, ['add', 'README.md']);
    git(operator, ['commit', '-qm', 'local seed']);
    git(operator, ['branch', '-M', 'main']);
    const binding = inspectLocalRepository(operator);
    const resolver = new RepositoryTruthResolver({
      repositoriesRoot: resolve(root, 'canonical'),
    });
    const truth = await resolver.resolve(binding, 'room-join');
    expect(truth.kind).toBe('local');
    expect(truth.checkoutPath).not.toBe(operator);
    expect(git(truth.checkoutPath, ['show', 'HEAD:README.md'])).toBe('local committed truth');
    expect(git(truth.checkoutPath, ['remote'])).toBe('');
    expect(truth.remoteUrl).toBeUndefined();
  });

  it('refreshes a renamed GitHub repository display name and URL', async () => {
    const f = fixture();
    const resolver = new RepositoryTruthResolver({
      repositoriesRoot: resolve(f.root, 'canonical'),
      resolveRemoteIdentity: async () => ({
        name: 'acme/renamed-repository',
        remote: 'git://github.com/acme/renamed-repository',
        cloneUrl: f.origin,
      }),
      runRemoteGit: (cwd, args) => {
        const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
        return {
          ok: result.status === 0,
          status: result.status,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        };
      },
    });
    const truth = await resolver.resolve(f.binding, 'room-join');
    expect(truth.binding.name).toBe('acme/renamed-repository');
    expect(truth.binding.remote).toBe('git://github.com/acme/renamed-repository');
  });

});
