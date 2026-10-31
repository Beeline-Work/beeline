import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { materializeAgentCornerCheckout } from './agent-corner-checkout.js';
import { withCornerCheckoutLock } from './corner-checkout-lock.js';

const exec = promisify(execFile);
it('two writers on the same corner branch have independent refs, files and locks', async () => {
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
    await withCornerCheckoutLock(a!.path, async () => {
      await withCornerCheckoutLock(b!.path, async () => {
        await writeFile(resolve(a!.path, 'file'), 'agent A');
        await git('-C', a!.path, 'add', '.');
        await git('-C', a!.path, 'commit', '-m', 'A change');
        expect(await readFile(resolve(b!.path, 'file'), 'utf8')).toBe('base');
        expect(await git('-C', b!.path, 'rev-parse', 'HEAD')).toBe(base);
      });
    });
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
