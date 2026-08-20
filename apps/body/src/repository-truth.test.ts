import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectLocalRepository } from './runtime.js';
import { RepositoryTruthResolver } from './repository-truth.js';

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

  it('fast-forwards an opted-in local-only pairing checkout from canonical truth', async () => {
    const root = mkdtempSync(join(tmpdir(), 'beeline-local-sync-'));
    cleanup.push(root);
    const operator = resolve(root, 'operator');
    git(root, ['init', '-q', operator]);
    git(operator, ['config', 'user.name', 'Local']);
    git(operator, ['config', 'user.email', 'local@example.invalid']);
    writeFileSync(resolve(operator, 'README.md'), 'seed\n');
    git(operator, ['add', 'README.md']);
    git(operator, ['commit', '-qm', 'seed']);
    git(operator, ['branch', '-M', 'main']);
    const resolver = new RepositoryTruthResolver({
      repositoriesRoot: resolve(root, 'canonical'),
      syncOperatorCheckout: true,
    });
    const truth = await resolver.resolve(inspectLocalRepository(operator), 'room-join');
    git(truth.checkoutPath, ['config', 'user.name', 'Canonical']);
    git(truth.checkoutPath, ['config', 'user.email', 'canonical@example.invalid']);
    writeFileSync(resolve(truth.checkoutPath, 'LANDED.txt'), 'landed\n');
    git(truth.checkoutPath, ['add', 'LANDED.txt']);
    git(truth.checkoutPath, ['commit', '-qm', 'land local truth']);
    const tip = git(truth.checkoutPath, ['rev-parse', 'HEAD']);

    await expect(resolver.syncPairingCheckout(truth, tip)).resolves.toMatchObject({
      status: 'fast-forwarded',
    });
    expect(git(operator, ['rev-parse', 'HEAD'])).toBe(tip);
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

  it('fast-forwards an opted-in clean operator checkout and refuses dirty or divergent work', async () => {
    const f = fixture();
    const writer = resolve(f.root, 'writer');
    git(f.root, ['clone', '-q', f.origin, writer]);
    git(writer, ['config', 'user.name', 'Writer']);
    git(writer, ['config', 'user.email', 'writer@example.invalid']);
    writeFileSync(resolve(writer, 'LANDED.txt'), 'landed\n');
    git(writer, ['add', 'LANDED.txt']);
    git(writer, ['commit', '-qm', 'land']);
    git(writer, ['push', '-q', 'origin', 'main']);
    const tip = git(writer, ['rev-parse', 'HEAD']);

    const resolver = new RepositoryTruthResolver({
      repositoriesRoot: resolve(f.root, 'canonical'),
      syncOperatorCheckout: true,
    });
    const truth = await resolver.resolve(f.binding, 'land');
    await expect(resolver.syncPairingCheckout(truth, tip)).resolves.toMatchObject({
      status: 'fast-forwarded',
    });
    expect(git(f.operator, ['rev-parse', 'HEAD'])).toBe(tip);

    writeFileSync(resolve(f.operator, 'DIRTY.txt'), 'captain work\n');
    await expect(resolver.syncPairingCheckout(truth, tip)).resolves.toMatchObject({
      status: 'refused',
      reason: 'dirty',
    });
    git(f.operator, ['clean', '-fd']);
    writeFileSync(resolve(f.operator, 'LOCAL.txt'), 'captain commit\n');
    git(f.operator, ['add', 'LOCAL.txt']);
    git(f.operator, ['commit', '-qm', 'captain local commit']);
    await expect(resolver.syncPairingCheckout(truth, tip)).resolves.toMatchObject({
      status: 'refused',
      reason: 'local-commits',
    });
  });
});
