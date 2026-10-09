import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { pruneDeletedRuntimes, pruneRepositoryCaches } from './host-disk-retention.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it('expires only correctly named old removed-agent homes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-retention-'));
  roots.push(root);
  const deleted = join(root, 'beeline', 'deleted-runtimes');
  const now = Date.now();
  const old = join(deleted, `${'a'.repeat(64)}-${now - 31 * 86400_000}`);
  const fresh = join(deleted, `${'b'.repeat(64)}-${now}`);
  const unknown = join(deleted, 'operator-notes');
  await Promise.all([old, fresh, unknown].map((path) => mkdir(path, { recursive: true })));
  expect(await pruneDeletedRuntimes(root, now)).toEqual([old]);
  await expect(access(old)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(fresh)).resolves.toBeUndefined();
  await expect(access(unknown)).resolves.toBeUndefined();
});

it('expires an old bare clone only if git has no linked checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-repo-retention-'));
  roots.push(root);
  const repositories = join(root, 'beeline', 'repositories');
  await mkdir(repositories, { recursive: true });
  const source = join(root, 'source');
  await execFileAsync('git', ['init', source]);
  await writeFile(join(source, 'README'), 'recoverable commit');
  await execFileAsync('git', ['-C', source, 'add', 'README']);
  await execFileAsync('git', ['-C', source, '-c', 'user.name=Bee', '-c', 'user.email=bee@example.test', 'commit', '-m', 'seed']);
  const bare = join(repositories, `${'c'.repeat(24)}.git`);
  await execFileAsync('git', ['clone', '--bare', source, bare]);
  const branch = (await execFileAsync('git', ['-C', source, 'symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  await execFileAsync('git', [`--git-dir=${bare}`, 'fetch', source,
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const checkout = join(root, 'checkout');
  await execFileAsync('git', [`--git-dir=${bare}`, 'worktree', 'add', '--detach', checkout]);
  const now = Date.now();
  await utimes(bare, new Date(now - 31 * 86400_000), new Date(now - 31 * 86400_000));
  expect(await pruneRepositoryCaches(root, now)).toEqual([]);
  await execFileAsync('git', [`--git-dir=${bare}`, 'worktree', 'remove', checkout]);
  await utimes(bare, new Date(now - 31 * 86400_000), new Date(now - 31 * 86400_000));
  expect(await pruneRepositoryCaches(root, now)).toEqual([bare]);
  await expect(access(bare)).rejects.toMatchObject({ code: 'ENOENT' });
});
