import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { cornerGitHubCommandRefusal, installCornerGitHubWrappers } from './corner-github-auth.js';

const execFileAsync = promisify(execFile);

describe('corner GitHub wrappers', () => {
  const featureBranch = 'corner/guard-123';
  const targetBranch = 'main';
  it.each([
    { launcher: 'git' as const, argv: ['push', 'origin', featureBranch], allowed: true },
    {
      launcher: 'git' as const,
      argv: ['push', '-u', 'origin', `HEAD:refs/heads/${featureBranch}`],
      allowed: true,
    },
    { launcher: 'git' as const, argv: ['push'], allowed: true },
    { launcher: 'git' as const, argv: ['push'], pushBranch: 'foreign', allowed: false },
    { launcher: 'git' as const, argv: ['push', 'origin', 'other'], allowed: false },
    { launcher: 'git' as const, argv: ['push', 'origin', `HEAD:${targetBranch}`], allowed: false },
    {
      launcher: 'git' as const,
      argv: ['push', '--force', 'origin', featureBranch],
      allowed: false,
    },
    {
      launcher: 'git' as const,
      argv: ['push', '--force-with-lease', 'origin', featureBranch],
      allowed: false,
    },
    {
      launcher: 'git' as const,
      argv: ['push', '-uf', 'origin', featureBranch],
      allowed: false,
    },
    {
      launcher: 'git' as const,
      argv: ['push', '--delete', 'origin', featureBranch],
      allowed: false,
    },
    { launcher: 'git' as const, argv: ['push', 'origin', 'refs/tags/v1.0.0'], allowed: false },
    { launcher: 'git' as const, argv: ['push', 'origin', 'v1.0.0'], allowed: false },
    { launcher: 'gh' as const, argv: ['pr', 'create', '--head', featureBranch], allowed: true },
    {
      launcher: 'gh' as const,
      argv: ['pr', 'create', `--head=owner:${featureBranch}`],
      allowed: true,
    },
    { launcher: 'gh' as const, argv: ['pr', 'create', '--head', 'other'], allowed: false },
    { launcher: 'gh' as const, argv: ['pr', 'list'], allowed: true },
  ])('$launcher $argv allowed=$allowed', ({ launcher, argv, allowed, pushBranch }) => {
    const resolve = (source?: string) =>
      source === 'v1.0.0'
        ? { branch: source, tag: true }
        : { branch: source ?? pushBranch ?? featureBranch, tag: false };
    expect(cornerGitHubCommandRefusal(launcher, argv, featureBranch, targetBranch, resolve)).toBe(
      allowed ? undefined : `beeline: this corner may push only ${featureBranch}`,
    );
  });

  it('mints lazily and retries an authentication failure exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-auth-'));
    const calls = join(root, 'calls');
    const cli = join(root, 'cli.mjs');
    const command = join(root, 'git.mjs');
    await writeFile(
      cli,
      `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(calls)}, 'token\\n'); console.log('fresh-token');`,
    );
    await writeFile(
      command,
      `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from 'node:fs';
const path=${JSON.stringify(calls)}; const prior=readFileSync(path,'utf8'); appendFileSync(path, process.env.GH_TOKEN+'\\n');
if (!prior.includes('fresh-token')) { console.error('HTTP 401'); process.exit(1); }
console.log('ok');`,
    );
    await Promise.all([chmod(cli, 0o700), chmod(command, 0o700)]);
    const env = await installCornerGitHubWrappers({
      root,
      runtimeConfigPath: '/runtime.json',
      roomId: 'room',
      cliEntrypoint: cli,
      gitBinary: command,
      ghBinary: command,
      featureBranch,
      targetBranch,
      inheritedPath: process.env.PATH,
    });

    expect(await readFile(calls, 'utf8').catch(() => '')).toBe('');
    const result = await execFileAsync(join(env.PATH!.split(':')[0]!, 'git'), ['fetch']);
    expect(result.stdout).toBe('ok\n');
    expect((await execFileAsync(join(env.PATH!.split(':')[0]!, 'gh'), ['pr', 'list'])).stdout).toBe(
      'ok\n',
    );
    const lines = (await readFile(calls, 'utf8')).trim().split('\n');
    expect(lines.filter((line) => line === 'token')).toHaveLength(3);
    expect(lines.filter((line) => line === 'fresh-token')).toHaveLength(3);
  });

  it('refuses a foreign destination before running git in a scratch repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-guard-'));
    const repo = join(root, 'repo');
    const remote = join(root, 'remote.git');
    const cli = join(root, 'cli.mjs');
    await writeFile(cli, '#!/usr/bin/env node\nconsole.log("fresh-token");\n');
    await chmod(cli, 0o700);
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['init', repo]);
    await execFileAsync('git', ['-C', repo, 'checkout', '-b', featureBranch]);
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Beeline Test']);
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'beeline@example.test']);
    await writeFile(join(repo, 'README.md'), 'guard test\n');
    await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repo, 'commit', '-m', 'test']);
    await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
    const gitBinary = (await execFileAsync('which', ['git'])).stdout.trim();
    const env = await installCornerGitHubWrappers({
      root,
      runtimeConfigPath: '/runtime.json',
      roomId: 'room',
      cliEntrypoint: cli,
      gitBinary,
      featureBranch,
      targetBranch,
      inheritedPath: process.env.PATH,
    });
    const launcher = join(env.PATH!.split(':')[0]!, 'git');

    await execFileAsync(launcher, ['push', '-u', 'origin', featureBranch], { cwd: repo });
    expect(
      (await execFileAsync('git', ['--git-dir', remote, 'show-ref', featureBranch])).stdout,
    ).toContain(`refs/heads/${featureBranch}`);
    await expect(
      execFileAsync(launcher, ['push', 'origin', 'foreign'], { cwd: repo }),
    ).rejects.toMatchObject({
      stderr: `beeline: this corner may push only ${featureBranch}\n`,
    });
  });
});
