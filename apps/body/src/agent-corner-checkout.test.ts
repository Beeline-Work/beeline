import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { materializeAgentCornerCheckout } from './agent-corner-checkout.js';

const exec = promisify(execFile);
it('two writers on the same corner branch have independent refs and files without checkout locks', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'agent-corner-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = async (...args: string[]) => (await exec('git', args, { env })).stdout.trim();
  try {
    const seed = resolve(root, 'seed');
    await git('init', '-b', 'main', seed);
    await writeFile(resolve(seed, 'file'), 'base');
    await git('-C', seed, 'add', '.');
    await git('-C', seed, 'commit', '-m', 'base');
    const base = await git('-C', seed, 'rev-parse', 'HEAD');
    const cache = resolve(root, 'cache.git');
    await git('clone', '--bare', seed, cache);
    const input = { root, cornerId: 'corner', sourceGitDir: cache, remote: cache,
      branch: 'feature/corner', startRef: 'refs/heads/main' };
    const [a, b] = await Promise.all(['a', 'b'].map(agentId => materializeAgentCornerCheckout({ ...input, agentId })));
    expect(a!.path).not.toBe(b!.path);
    expect(a!.gitCommonDir).not.toBe(b!.gitCommonDir);
        await writeFile(resolve(a!.path, 'file'), 'agent A');
        await git('-C', a!.path, 'add', '.');
        await git('-C', a!.path, 'commit', '-m', 'A change');
        expect(await readFile(resolve(b!.path, 'file'), 'utf8')).toBe('base');
        expect(await git('-C', b!.path, 'rev-parse', 'HEAD')).toBe(base);
    const object = `objects/${base.slice(0, 2)}/${base.slice(2)}`;
    expect((await stat(resolve(a!.gitCommonDir, object))).ino)
      .toBe((await stat(resolve(b!.gitCommonDir, object))).ino);
    await writeFile(resolve(a!.path, 'unfinished'), 'keep my work');
    expect(await materializeAgentCornerCheckout({ ...input, agentId: 'a' })).toEqual(a);
    expect(await readFile(resolve(a!.path, 'unfinished'), 'utf8')).toBe('keep my work');
    expect(await git('-C', a!.path, 'show', 'HEAD:file')).toBe('agent A');
    // No alternates: losing the seed/cache cannot invalidate either copy.
    await rm(cache, { recursive: true, force: true });
    expect(await git('-C', b!.path, 'show', 'HEAD:file')).toBe('base');
    expect(await git('-C', a!.path, 'show', 'HEAD:file')).toBe('agent A');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('hands legacy unpublished commits, staged deletions, edits and untracked files only to the implementer', async () => {
  const { materializeCornerWorktree, cornerRepositoryCacheDir, removeCornerWorktreeAndBranches } = await import('./room-runtime.js');
  const { reclaimOwnedCheckout } = await import('./storage-owners.js');
  const { mkdir, access } = await import('node:fs/promises');
  const { basename } = await import('node:path');
  const root = await mkdtemp(resolve(tmpdir(), 'corner-migrate-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = async (...args: string[]) => (await exec('git', args, { env })).stdout.trim();
  try {
    const seed = resolve(root, 'seed'), remote = resolve(root, 'remote.git');
    await git('init', '-b', 'main', seed);
    await writeFile(resolve(seed, 'file'), 'base');
    await writeFile(resolve(seed, 'deleted'), 'delete me');
    await writeFile(resolve(seed, '.gitignore'), 'node_modules\n');
    await git('-C', seed, 'add', '.'); await git('-C', seed, 'commit', '-m', 'base');
    await git('clone', '--bare', seed, remote);
    const input = { supervisorRoot: root, cornerId: 'corner', remote: `file://${remote}`,
      targetBranch: 'main', featureBranch: 'feature/corner', token: 'fixture' };
    const peer = await materializeCornerWorktree({ ...input, committer: { name: 'B', publicKey: 'b' } });
    const cache = cornerRepositoryCacheDir(root, input.remote);
    const legacy = resolve(root, 'beeline/corners/corner');
    await git(`--git-dir=${cache}`, 'config', 'extensions.worktreeConfig', 'true');
    await git(`--git-dir=${cache}`, 'worktree', 'add', '-b', input.featureBranch, legacy, 'main');
    await git('-C', legacy, 'config', '--worktree', 'core.bare', 'false');
    await writeFile(resolve(legacy, 'file'), 'unpublished commit');
    await git('-C', legacy, 'add', '.'); await git('-C', legacy, 'commit', '-m', 'unpublished');
    const head = await git('-C', legacy, 'rev-parse', 'HEAD');
    await writeFile(resolve(legacy, 'file'), 'staged change'); await git('-C', legacy, 'add', 'file');
    await writeFile(resolve(legacy, 'file'), 'unfinished edit');
    await git('-C', legacy, 'rm', 'deleted');
    await writeFile(resolve(legacy, 'untracked'), 'work');
    await mkdir(resolve(legacy, 'node_modules/proof'), { recursive: true });
    await writeFile(resolve(legacy, 'node_modules/proof/data'), 'warm');
    const writer = await materializeCornerWorktree({ ...input, migrateLegacy: true, committer: { name: 'A', publicKey: 'a' } });
    expect(await git('-C', writer.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git('-C', writer.path, 'status', '--porcelain')).toBe(await git('-C', legacy, 'status', '--porcelain'));
    expect(await readFile(resolve(writer.path, 'file'), 'utf8')).toBe('unfinished edit');
    expect(await readFile(resolve(writer.path, 'node_modules/proof/data'), 'utf8')).toBe('warm');
    expect((await stat(resolve(writer.path, 'node_modules/proof/data'))).ino).not.toBe((await stat(resolve(legacy, 'node_modules/proof/data'))).ino);
    await writeFile(resolve(writer.path, 'file'), 'writer continues');
    await materializeCornerWorktree({ ...input, migrateLegacy: true, committer: { name: 'A', publicKey: 'a' } });
    expect(await readFile(resolve(writer.path, 'file'), 'utf8')).toBe('writer continues');
    expect(await readFile(resolve(legacy, 'file'), 'utf8')).toBe('unfinished edit');
    expect(await readFile(resolve(peer.path, 'file'), 'utf8')).toBe('base');
    expect(await reclaimOwnedCheckout(root, { workspaceId: 'workspace', roomId: 'corner', kind: 'corners', itemId: basename(writer.path), agentId: 'a' }, { inUse: async () => false })).toEqual([]);
    await removeCornerWorktreeAndBranches({ ...peer, cornerId: 'corner', branch: input.featureBranch, token: '' });
    await expect(access(peer.path)).rejects.toThrow();
    await expect(access(peer.gitCommonDir)).rejects.toThrow();
    expect(await readFile(resolve(writer.path, 'file'), 'utf8')).toBe('writer continues');
  } finally { await rm(root, { recursive: true, force: true }); }
});
