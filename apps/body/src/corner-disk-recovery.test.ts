import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { preserveUnpublishedCornerWorktree } from './corner-disk-recovery.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

it('keeps unpublished source and records its HEAD while pruning only ignored build output', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-recovery-'));
  roots.push(root);
  const checkout = resolve(root, 'beeline', 'corners', 'corner-recovery');
  await mkdir(checkout, { recursive: true });
  const git = async (...args: string[]) => execFileAsync('git', ['-C', checkout, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  await git('init', '-b', 'main');
  await writeFile(resolve(checkout, '.gitignore'), 'node_modules/\ntarget/\ndist/\n');
  await writeFile(resolve(checkout, 'source.ts'), 'recover me\n');
  await git('add', '.gitignore', 'source.ts');
  await git('commit', '-m', 'unpublished');
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  await mkdir(resolve(checkout, 'apps', 'mobile', 'node_modules'), { recursive: true });
  await mkdir(resolve(checkout, 'target'), { recursive: true });
  await mkdir(resolve(checkout, 'build'), { recursive: true });
  await writeFile(resolve(checkout, 'apps', 'mobile', 'node_modules', 'package'), 'generated');
  await writeFile(resolve(checkout, 'target', 'object'), 'generated');
  await writeFile(resolve(checkout, 'build', 'valuable-untracked.txt'), 'keep');

  const saved = await preserveUnpublishedCornerWorktree(
    { path: checkout, cornerId: 'corner-recovery', branch: 'main' },
    'has unpushed commits',
  );
  expect(saved.pruned).toEqual(expect.arrayContaining(['apps/mobile/node_modules', 'target']));
  expect(JSON.parse(await readFile(saved.pointer, 'utf8'))).toMatchObject({
    checkout, head, branch: 'main', cornerId: 'corner-recovery',
  });
  expect(await readFile(resolve(checkout, 'source.ts'), 'utf8')).toBe('recover me\n');
  expect(await readFile(resolve(checkout, 'build', 'valuable-untracked.txt'), 'utf8')).toBe('keep');
  await expect(access(resolve(checkout, 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(resolve(checkout, 'apps', 'mobile', 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
});
