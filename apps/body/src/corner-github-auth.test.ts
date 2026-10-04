import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { cornerGitHubCommandRefusal, installCornerGitHubWrappers } from './corner-github-auth.js';

const execFileAsync = promisify(execFile);

async function slowPipe(command: string, argv: string[]) {
  const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stdout.pause();
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  // A slow pipe consumer exposes premature process.exit() after a large write.
  await new Promise((resolve) => setTimeout(resolve, 250));
  child.stdout.resume();
  const code = await closed;
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

describe('corner GitHub wrappers', () => {
  const featureBranch = 'corner/guard-123';
  const targetBranch = 'main';
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(gitBinary = '/usr/bin/git', ghSource?: string) {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-output-'));
    roots.push(root);
    const calls = join(root, 'tokens');
    const cli = join(root, 'cli.mjs');
    await writeFile(
      cli,
      `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, 'token\\n'); console.log('test-token');`,
    );
    let ghBinary: string | undefined;
    if (ghSource) {
      ghBinary = join(root, 'gh.mjs');
      await writeFile(ghBinary, '#!/usr/bin/env node\n' + ghSource);
      await chmod(ghBinary, 0o700);
    }
    const { env } = await installCornerGitHubWrappers({
      root,
      runtimeConfigPath: '/runtime.json',
      roomId: 'room',
      cliEntrypoint: cli,
      gitBinary,
      ghBinary,
      featureBranch,
      targetBranch,
      inheritedPath: process.env.PATH,
    });
    const bin = env.PATH!.split(':')[0]!;
    return { root, calls, git: join(bin, 'git'), gh: join(bin, 'gh') };
  }

  it.each([68 * 1024, 512 * 1024, 2 * 1024 * 1024])(
    'pipes a real Git blob of %i bytes intact',
    async (size) => {
      const { root, git } = await fixture();
      await execFileAsync('/usr/bin/git', ['init', root]);
      const blob = Buffer.alloc(size);
      for (let index = 0; index < size; index += 1) blob[index] = index % 256;
      await writeFile(join(root, 'blob'), blob);
      await execFileAsync('/usr/bin/git', ['-C', root, 'add', 'blob']);
      await execFileAsync('/usr/bin/git', [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-m',
        'blob',
      ]);
      const result = await slowPipe(git, ['-C', root, 'show', 'HEAD:blob']);
      expect(result.code, result.stderr.toString().slice(-2000)).toBe(0);
      expect(result.stdout.length).toBe(size);
      expect(result.stdout.equals(blob)).toBe(true);
      console.log(`Git show: ${result.stdout.length}/${size} bytes, byte-for-byte match`);
    },
  );

  it('pipes large gh stdout and stderr intact', async () => {
    const size = 2 * 1024 * 1024;
    const { gh, calls } = await fixture(
      '/usr/bin/git',
      `
if (process.env.GH_TOKEN !== 'test-token') process.exit(2);
process.stdout.write(Buffer.alloc(${size}, 120));
process.stderr.write(Buffer.alloc(${size}, 121));`,
    );
    const result = await slowPipe(gh, ['run', 'view', '--log']);
    expect(result.code, result.stderr.toString().slice(-2000)).toBe(0);
    expect(result.stdout.equals(Buffer.alloc(size, 120))).toBe(true);
    expect(result.stderr.equals(Buffer.alloc(size, 121))).toBe(true);
    expect(await readFile(calls, 'utf8')).toBe('token\n');
    console.log(
      `gh run view --log: ${result.stdout.length} stdout bytes and ${result.stderr.length} stderr bytes intact`,
    );
  });

  it('runs local Git commands without requesting a token', async () => {
    const { root, git, calls } = await fixture();
    await execFileAsync(git, ['init', root]);
    await writeFile(join(root, 'file'), 'local fixture\n');
    const commands = [
      ['-C', root, 'add', 'file'],
      [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-m',
        'local',
      ],
      ['-C', root, 'status', '--short'],
      ['--git-dir', join(root, '.git'), 'ls-files'],
      ['-C', root, 'show', 'HEAD:file'],
      ['-C', root, 'cat-file', '-p', 'HEAD:file'],
      ['-C', root, 'rev-parse', 'HEAD'],
    ];
    for (const argv of commands) await execFileAsync(git, argv);
    expect(await readFile(calls, 'utf8').catch(() => '')).toBe('');
    console.log(
      'Local init/add/commit/status/ls-files/show/cat-file/rev-parse: zero token requests',
    );
  });

  it.each([
    { launcher: 'git', argv: ['fetch'] },
    { launcher: 'git', argv: ['push', 'origin', featureBranch] },
    { launcher: 'git', argv: ['ls-remote'] },
    { launcher: 'gh', argv: ['api', 'repos/owner/repo'] },
  ])('refreshes and retries authentication for $launcher $argv', async ({ launcher, argv }) => {
    const { root } = await fixture();
    const command = join(root, 'remote.mjs');
    const source = `import { existsSync, writeFileSync } from 'node:fs';
if (process.env.GH_TOKEN !== 'test-token' || process.env.GITHUB_TOKEN !== 'test-token') process.exit(2);
const marker = ${JSON.stringify(join(root, 'attempt'))};
if (!existsSync(marker)) {
  writeFileSync(marker, 'failed');
  process.stderr.write('HTTP ');
  setTimeout(() => { process.stderr.write('401\\n'); process.exitCode = 1; }, 25);
} else console.log('remote ok');`;
    await writeFile(command, '#!/usr/bin/env node\n' + source);
    await chmod(command, 0o700);
    const { git, gh, calls } = await fixture(command, source);
    const result = await execFileAsync(launcher === 'git' ? git : gh, argv);
    expect(result.stdout).toBe('remote ok\n');
    expect(result.stderr).toBe('HTTP 401\n');
    expect(await readFile(calls, 'utf8')).toBe('token\ntoken\n');
  });

  it.each([
    { diagnostic: 'HTTP 403', code: 1, tokens: 'token\ntoken\n' },
    { diagnostic: 'ordinary command failure', code: 7, tokens: 'token\n' },
  ])(
    'preserves exit status and bounds retries for $diagnostic',
    async ({ diagnostic, code, tokens }) => {
      const { gh, calls } = await fixture(
        '/usr/bin/git',
        `console.error(${JSON.stringify(diagnostic)}); process.exitCode = ${code};`,
      );
      await expect(execFileAsync(gh, ['api', 'repos/owner/repo'])).rejects.toMatchObject({ code });
      expect(await readFile(calls, 'utf8')).toBe(tokens);
    },
  );

  it('does not refresh or retry a local failure that mentions authentication', async () => {
    const { root } = await fixture();
    const command = join(root, 'local.mjs');
    await writeFile(
      command,
      '#!/usr/bin/env node\nconsole.error("HTTP 401"); process.exitCode = 7;',
    );
    await chmod(command, 0o700);
    const { git, calls } = await fixture(command);
    await expect(execFileAsync(git, ['status'])).rejects.toMatchObject({
      code: 7,
      stderr: 'HTTP 401\n',
    });
    expect(await readFile(calls, 'utf8').catch(() => '')).toBe('');
  });
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
    const { env } = await installCornerGitHubWrappers({
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

  it('recovers from a transient token lookup using the same Room and refuses a persistent failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-token-'));
    const calls = join(root, 'calls');
    const cli = join(root, 'cli.mjs');
    const command = join(root, 'git.mjs');
    await writeFile(
      cli,
      `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from 'node:fs';
const path=${JSON.stringify(calls)}; let prior=''; try { prior=readFileSync(path,'utf8'); } catch {}
appendFileSync(path, process.argv.slice(2).join(' ')+'\\n');
if (prior.split('\\n').filter(Boolean).length < 2 || process.env.ALWAYS_FAIL === '1') process.exit(1);
console.log('room-token');`,
    );
    await writeFile(
      command,
      `#!/usr/bin/env node\nif (process.env.GH_TOKEN !== 'room-token') process.exit(1); console.log('ok');`,
    );
    await Promise.all([chmod(cli, 0o700), chmod(command, 0o700)]);
    const { env } = await installCornerGitHubWrappers({
      root,
      runtimeConfigPath: '/runtime.json',
      roomId: 'exact-room',
      cliEntrypoint: cli,
      gitBinary: command,
      featureBranch,
      targetBranch,
      inheritedPath: process.env.PATH,
    });
    const launcher = join(env.PATH!.split(':')[0]!, 'git');
    expect((await execFileAsync(launcher, ['fetch'])).stdout).toBe('ok\n');
    expect((await readFile(calls, 'utf8')).trim().split('\n')).toEqual(
      Array(3).fill('corner-read-token --config /runtime.json --room exact-room'),
    );
    await expect(
      execFileAsync(launcher, ['fetch'], { env: { ...process.env, ALWAYS_FAIL: '1' } }),
    ).rejects.toMatchObject({ code: 1 });
    expect((await readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(6);
  });

  it('scopes the branch rule to the real origin, allowing a fixture remote', () => {
    const resolve = () => ({ branch: 'anything', tag: false });
    const notOrigin = () => false;
    // Same argv the table above refuses, but aimed at a local fixture remote.
    for (const argv of [
      ['push', 'fixture', 'foreign'],
      ['push', '--force', 'fixture', featureBranch],
      ['push', 'fixture', 'refs/tags/v1.0.0'],
    ]) {
      expect(
        cornerGitHubCommandRefusal('git', argv, featureBranch, targetBranch, resolve, notOrigin),
      ).toBeUndefined();
    }
    // A push to the real origin is still refused.
    expect(
      cornerGitHubCommandRefusal(
        'git',
        ['push', 'origin', 'foreign'],
        featureBranch,
        targetBranch,
        resolve,
        () => true,
      ),
    ).toBe(`beeline: this corner may push only ${featureBranch}`);
  });

  it('refuses a foreign destination before running git in a scratch repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-guard-'));
    roots.push(root);
    const repo = join(root, 'repo');
    const remote = join(root, 'remote.git');
    const cli = join(root, 'cli.mjs');
    const calls = join(root, 'tokens');
    await writeFile(
      cli,
      `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, 'token\\n'); console.log('fresh-token');`,
    );
    await chmod(cli, 0o700);
    await execFileAsync('/usr/bin/git', ['init', '--bare', remote]);
    await execFileAsync('/usr/bin/git', ['init', repo]);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'checkout', '-b', featureBranch]);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'config', 'user.name', 'Beeline Test']);
    await execFileAsync('/usr/bin/git', [
      '-C',
      repo,
      'config',
      'user.email',
      'beeline@example.test',
    ]);
    await writeFile(join(repo, 'README.md'), 'guard test\n');
    await execFileAsync('/usr/bin/git', ['-C', repo, 'add', 'README.md']);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'commit', '-m', 'test']);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'remote', 'add', 'origin', remote]);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'tag', 'v1.0.0']);
    const gitBinary = '/usr/bin/git';
    const { env } = await installCornerGitHubWrappers({
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
      (await execFileAsync('/usr/bin/git', ['--git-dir', remote, 'show-ref', featureBranch]))
        .stdout,
    ).toContain(`refs/heads/${featureBranch}`);
    await expect(
      execFileAsync(launcher, ['push', 'origin', 'foreign'], { cwd: repo }),
    ).rejects.toMatchObject({
      stderr: `beeline: this corner may push only ${featureBranch}\n`,
    });
    for (const refspec of ['v1.0.0', `HEAD:refs/tags/${featureBranch}`, 'HEAD:main']) {
      await expect(
        execFileAsync(launcher, ['push', 'origin', refspec], { cwd: repo }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: `beeline: this corner may push only ${featureBranch}\n`,
      });
    }
    expect(await readFile(calls, 'utf8')).toBe('token\n');
  });

  async function restServer(
    handler: (
      request: { method: string; url: string; body: string; authorization?: string },
      response: ServerResponse,
    ) => void,
  ) {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () =>
        handler(
          {
            method: request.method ?? '',
            url: request.url ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
            authorization: request.headers.authorization,
          },
          response,
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('opens and reads a pull request over REST when no host gh exists', async () => {
    const requests: Array<{ method: string; url: string; authorization?: string }> = [];
    const api = await restServer((request, response) => {
      requests.push(request);
      if (request.method === 'POST' && request.url === '/repos/acme/widget/pulls') {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ number: 12, html_url: 'https://github.com/acme/widget/pull/12' }),
        );
        return;
      }
      if (request.url === '/repos/acme/widget/pulls/12') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            number: 12,
            html_url: 'https://github.com/acme/widget/pull/12',
            title: 'A change',
            state: 'open',
            head: { ref: featureBranch, sha: 'a'.repeat(40) },
            base: { ref: targetBranch },
            draft: false,
            body: 'body',
            mergeable: true,
            mergeable_state: 'clean',
          }),
        );
        return;
      }
      if (request.url?.startsWith('/repos/acme/widget/pulls/12/files')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify([
            { filename: 'apps/body/src/a.ts', additions: 3, deletions: 1, status: 'modified' },
          ]),
        );
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Not Found' }));
    });
    try {
      const { gh, calls } = await fixture();
      const env = { ...process.env, GITHUB_API_URL: api.url };
      const created = await execFileAsync(
        gh,
        ['pr', 'create', '--repo', 'acme/widget', '--title', 'A change', '--body', 'body'],
        { env },
      );
      expect(created.stdout.trim()).toBe('https://github.com/acme/widget/pull/12');
      const viewed = await execFileAsync(
        gh,
        ['pr', 'view', '12', '--repo', 'acme/widget', '--json', 'headRefOid,files'],
        { env },
      );
      expect(JSON.parse(viewed.stdout)).toEqual({
        headRefOid: 'a'.repeat(40),
        files: [{ path: 'apps/body/src/a.ts', additions: 3, deletions: 1, changeType: 'modified' }],
      });
      expect(requests).toHaveLength(3);
      expect(requests.every((request) => request.authorization === 'Bearer test-token')).toBe(true);
      expect(await readFile(calls, 'utf8')).toBe('token\ntoken\n');
      console.log('REST fallback: gh pr create + gh pr view served with the app token');
    } finally {
      await api.close();
    }
  });

  it('falls back to REST when the host gh rejects the app token', async () => {
    let posts = 0;
    const api = await restServer((request, response) => {
      if (request.method === 'POST') {
        posts += 1;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ html_url: 'https://github.com/acme/widget/pull/9' }));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
    });
    try {
      const { gh } = await fixture(
        '/usr/bin/git',
        "process.stderr.write('not logged into any GitHub hosts\n'); process.exit(1);",
      );
      const env = { ...process.env, GITHUB_API_URL: api.url };
      const created = await execFileAsync(
        gh,
        ['pr', 'create', '--repo', 'acme/widget', '--title', 't', '--body', 'b'],
        { env },
      );
      expect(created.stdout.trim()).toBe('https://github.com/acme/widget/pull/9');
      expect(posts).toBe(1);
      console.log('Unauthenticated host gh: fell back to the REST path');
    } finally {
      await api.close();
    }
  });

  it('creates the feature branch remote-tracking ref after a launcher push', async () => {
    const { root, git } = await fixture();
    const repo = join(root, 'repo');
    const remote = join(root, 'remote.git');
    await execFileAsync('/usr/bin/git', ['init', '--bare', remote]);
    await execFileAsync('/usr/bin/git', ['init', '-b', featureBranch, repo]);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'config', 'user.name', 'Beeline Test']);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'config', 'user.email', 'beeline@example.test']);
    await writeFile(join(repo, 'README.md'), 'tracking test\n');
    await execFileAsync('/usr/bin/git', ['-C', repo, 'add', 'README.md']);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'commit', '-m', 'test']);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'remote', 'add', 'origin', remote]);
    await execFileAsync(git, ['push', 'origin', featureBranch], { cwd: repo });
    const resolved = await execFileAsync('/usr/bin/git', [
      '-C',
      repo,
      'rev-parse',
      '--verify',
      `refs/remotes/origin/${featureBranch}`,
    ]);
    expect(resolved.stdout.trim()).toHaveLength(40);
    console.log(`Push tracking ref: refs/remotes/origin/${featureBranch} = ${resolved.stdout.trim()}`);
  });

  it('allows a test suite to push any branch to a local fixture remote', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-fixture-'));
    roots.push(root);
    const repo = join(root, 'repo');
    const remote = join(root, 'remote.git');
    const cli = join(root, 'cli.mjs');
    const calls = join(root, 'tokens');
    await writeFile(
      cli,
      `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, 'token\\n'); console.log('fresh-token');`,
    );
    await chmod(cli, 0o700);
    await execFileAsync('/usr/bin/git', ['init', '--bare', remote]);
    await execFileAsync('/usr/bin/git', ['init', repo]);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'checkout', '-b', featureBranch]);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'config', 'user.name', 'Beeline Test']);
    await execFileAsync('/usr/bin/git', [
      '-C',
      repo,
      'config',
      'user.email',
      'beeline@example.test',
    ]);
    await writeFile(join(repo, 'README.md'), 'fixture test\n');
    await execFileAsync('/usr/bin/git', ['-C', repo, 'add', 'README.md']);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'commit', '-m', 'test']);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'remote', 'add', 'fixture', remote]);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'tag', 'v1.0.0']);
    const { env } = await installCornerGitHubWrappers({
      root,
      runtimeConfigPath: '/runtime.json',
      roomId: 'room',
      cliEntrypoint: cli,
      gitBinary: '/usr/bin/git',
      featureBranch,
      targetBranch,
      originUrl: 'https://github.com/beeline-test/repo.git',
      inheritedPath: process.env.PATH,
    });
    const launcher = join(env.PATH!.split(':')[0]!, 'git');
    // The guard once refused every one of these because the branch name did
    // not match the corner's feature branch, even though the remote is a
    // throwaway fixture the test suite owns.
    await execFileAsync(launcher, ['-C', repo, 'push', 'fixture', 'HEAD:foreign']);
    await execFileAsync(launcher, ['-C', repo, 'push', 'fixture', 'refs/tags/v1.0.0']);
    expect(
      (await execFileAsync('/usr/bin/git', ['--git-dir', remote, 'show-ref', 'foreign'])).stdout,
    ).toContain('refs/heads/foreign');
  });

  it('refuses a configured pushurl that points away from a local fixture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-corner-pushurl-'));
    roots.push(root);
    const repo = join(root, 'repo');
    const remote = join(root, 'remote.git');
    const cli = join(root, 'cli.mjs');
    const calls = join(root, 'tokens');
    await writeFile(
      cli,
      `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, 'token\\n'); console.log('fresh-token');`,
    );
    await chmod(cli, 0o700);
    await execFileAsync('/usr/bin/git', ['init', '--bare', remote]);
    await execFileAsync('/usr/bin/git', ['init', repo]);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'checkout', '-b', featureBranch]);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'config', 'user.name', 'Beeline Test']);
    await execFileAsync('/usr/bin/git', [
      '-C',
      repo,
      'config',
      'user.email',
      'beeline@example.test',
    ]);
    await writeFile(join(repo, 'README.md'), 'pushurl test\n');
    await execFileAsync('/usr/bin/git', ['-C', repo, 'add', 'README.md']);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'commit', '-m', 'test']);
    await execFileAsync('/usr/bin/git', ['-C', repo, 'remote', 'add', 'origin', remote]);
    // A remote whose fetch URL looks like a local fixture but whose push URL
    // leaves the machine: the branch rule must follow the URL git actually
    // pushes to, never remote.<name>.url.
    await execFileAsync('/usr/bin/git', [
      '-C',
      repo,
      'remote',
      'add',
      'decoy',
      join(root, 'nonexistent.git'),
    ]);
    await execFileAsync('/usr/bin/git', [
      '-C',
      repo,
      'config',
      'remote.decoy.pushurl',
      'https://127.0.0.1:1/repo.git',
    ]);
    const { env } = await installCornerGitHubWrappers({
      root,
      runtimeConfigPath: '/runtime.json',
      roomId: 'room',
      cliEntrypoint: cli,
      gitBinary: '/usr/bin/git',
      featureBranch,
      targetBranch,
      originUrl: 'https://github.com/beeline-test/repo.git',
      inheritedPath: process.env.PATH,
    });
    const launcher = join(env.PATH!.split(':')[0]!, 'git');
    await expect(
      execFileAsync(launcher, ['push', 'decoy', 'HEAD:foreign'], { cwd: repo }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: `beeline: this corner may push only ${featureBranch}\n`,
    });
    // The same redirection through command-line config is refused too.
    await expect(
      execFileAsync(
        launcher,
        [
          '-c',
          'remote.evil.url=/nonexistent',
          '-c',
          'remote.evil.pushurl=https://127.0.0.1:1/repo.git',
          'push',
          'evil',
          'HEAD:foreign2',
        ],
        { cwd: repo },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: `beeline: this corner may push only ${featureBranch}\n`,
    });
    expect(
      (
        await execFileAsync('/usr/bin/git', [
          '--git-dir',
          remote,
          'for-each-ref',
          '--format=%(refname)',
        ])
      ).stdout,
    ).not.toContain('foreign');
  });
});
