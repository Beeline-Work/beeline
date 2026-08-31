import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  GIT_GITHUB_TOKEN_URL_SCOPE,
  githubCliWrapperScript,
  githubCredentialHelperScript,
  prepareGitHubCredentialHelper,
  resolveBeelineCliEntrypoint,
} from './corner-read-token.js';

const cleanup: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/${prefix}-`);
  cleanup.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function wiringInput(stateDir: string) {
  return {
    roomId: '11111111-1111-4111-8111-111111111111',
    stateDir,
    nodePath: process.execPath,
    cliEntrypoint: '/opt/beeline/lib/beeline/beeline-cli.mjs',
    runtimeConfigPath: '/home/op/.local/state/beeline/agents/abc/runtime.json',
    path: process.env.PATH ?? '/usr/bin:/bin',
  };
}

describe('corner GitHub credential wiring', () => {
  it('wires git and a transparent gh refresh launcher inside the session PATH', async () => {
    const stateDir = await tempDir('beeline-github-token');
    const wiring = await prepareGitHubCredentialHelper(wiringInput(stateDir));

    expect(wiring.helperPath).toBe(`${stateDir}/beeline-git-credential.sh`);
    expect(wiring.ghWrapperPath).toBe(`${stateDir}/bin/gh`);
    expect(wiring.env).toMatchObject({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: GIT_GITHUB_TOKEN_URL_SCOPE,
      GIT_CONFIG_VALUE_0: wiring.helperPath,
    });
    expect(wiring.env.PATH).toBe(`${stateDir}/bin:${wiringInput(stateDir).path}`);
    expect(await readFile(wiring.helperPath, 'utf8')).toContain('corner-git-credential');
    const wrapper = await readFile(wiring.ghWrapperPath, 'utf8');
    expect(wrapper).toContain(`${wiring.helperPath}' get`);
    expect(wrapper).toContain('GH_TOKEN="$token" exec gh "$@"');
  });

  it('pins helper refresh to the daemon runtime and parent Room', () => {
    const input = wiringInput('/tmp/state');
    const script = githubCredentialHelperScript(input);
    expect(script).toContain(`exec '${process.execPath}'`);
    expect(script).toContain("'/opt/beeline/lib/beeline/beeline-cli.mjs'");
    expect(script).toContain(`--config '${input.runtimeConfigPath}'`);
    expect(script).toContain(`--room '${input.roomId}'`);
  });

  it('makes real git consult the repository-scoped helper', async () => {
    const stateDir = await tempDir('beeline-github-token');
    const worktree = await tempDir('beeline-github-repo');
    const fakeCli = await tempDir('beeline-fake-cli');
    const entrypoint = `${fakeCli}/fake-beeline-cli.mjs`;
    await writeFile(
      entrypoint,
      "console.log('username=x-access-token');\nconsole.log('password=write-token-123');\n",
    );
    await chmod(entrypoint, 0o755);
    const wiring = await prepareGitHubCredentialHelper({
      ...wiringInput(stateDir),
      cliEntrypoint: entrypoint,
    });

    expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: worktree }).status).toBe(0);
    expect(
      spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/private.git'], {
        cwd: worktree,
      }).status,
    ).toBe(0);
    const fill = spawnSync('git', ['credential', 'fill'], {
      cwd: worktree,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: fakeCli,
        GIT_CONFIG_NOSYSTEM: '1',
        ...wiring.env,
      },
      input: 'protocol=https\nhost=github.com\n\n',
    });
    expect(fill.status, fill.stderr).toBe(0);
    expect(fill.stdout).toContain('password=write-token-123');
  });

  it('the gh launcher refreshes a token without printing it', () => {
    const script = githubCliWrapperScript('/state/helper', '/usr/bin:/bin');
    expect(script).toContain("'/state/helper' get");
    expect(script).not.toContain('echo "$token"');
  });

  it('accepts built JS entrypoints and rejects development TypeScript entrypoints', () => {
    expect(resolveBeelineCliEntrypoint(['node', '/opt/b/beeline-cli.mjs'])).toBe(
      '/opt/b/beeline-cli.mjs',
    );
    expect(resolveBeelineCliEntrypoint(['node', '/opt/b/cli.js'])).toBe('/opt/b/cli.js');
    expect(resolveBeelineCliEntrypoint(['tsx', '/repo/src/cli.ts'])).toBeUndefined();
  });
});
