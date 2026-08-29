import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  GIT_READ_TOKEN_URL_SCOPE,
  prepareGitReadTokenHelper,
  readTokenHelperScript,
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
    nodePath: '/usr/bin/node',
    cliEntrypoint: '/opt/beeline/lib/beeline/beeline-cli.mjs',
    runtimeConfigPath: '/home/op/.local/state/beeline/agents/abc/runtime.json',
  };
}

describe('corner read-token credential helper', () => {
  it('writes an executable helper and wires it through GIT_CONFIG env, scoped to github.com', async () => {
    const stateDir = await tempDir('beeline-read-token');
    const wiring = await prepareGitReadTokenHelper(wiringInput(stateDir));

    expect(wiring.helperPath).toBe(`${stateDir}/beeline-git-read-credential.sh`);
    // The helper reaches git ONLY through these env entries. No GH_TOKEN /
    // GITHUB_TOKEN-style name exists anywhere — the #376 denylist is untouched
    // and cannot be defeated by this channel.
    expect(wiring.env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: GIT_READ_TOKEN_URL_SCOPE,
      GIT_CONFIG_VALUE_0: `${stateDir}/beeline-git-read-credential.sh`,
    });
    expect(GIT_READ_TOKEN_URL_SCOPE).toBe('credential.https://github.com.helper');

    const script = await readFile(wiring.helperPath, 'utf8');
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('read-only');
    expect(script).toContain('contents:read + metadata:read');
    // The exact mint contract the auth service enforces, restated in the
    // artifact itself so a drift on either side shows up in review.
  });

  it('the helper execs the CLI pinned to the daemon runtime and parent Room id', async () => {
    const input = wiringInput('/tmp/state');
    const script = readTokenHelperScript(input);
    expect(script).toContain("exec '/usr/bin/node'");
    expect(script).toContain("'/opt/beeline/lib/beeline/beeline-cli.mjs'");
    expect(script).toContain('corner-git-credential');
    expect(script).toContain(
      `--config '${input.runtimeConfigPath}'`,
    );
    // The PARENT room id (runtime records list Rooms, never corners), so the
    // auth service derives the repository binding from Room truth itself.
    expect(script).toContain(`--room '${input.roomId}'`);
  });

  it('git consults the env-wired helper for github.com remotes and runs it', async () => {
    const stateDir = await tempDir('beeline-read-token');
    const worktree = await tempDir('beeline-read-token-repo');
    const fakeEntrypoint = await tempDir('beeline-fake-cli');

    // A stand-in "CLI" proving the helper's exec chain end to end (the real
    // entrypoint runs under the pinned node interpreter, so this one does too).
    const entrypointPath = `${fakeEntrypoint}/fake-beeline-cli.mjs`;
    await writeFile(
      entrypointPath,
      "console.log('username=x-access-token');\nconsole.log('password=ro-token-123');\n",
    );
    await chmod(entrypointPath, 0o755);

    // Real execution needs the node interpreter that is actually on this
    // host (production passes the daemon's own `process.execPath`); a fixed
    // `/usr/bin/node` only happens to exist on some hosts.
    const wiring = await prepareGitReadTokenHelper({
      ...wiringInput(stateDir),
      nodePath: process.execPath,
      cliEntrypoint: entrypointPath,
    });

    run(worktree, ['init', '-q', '-b', 'main']);
    run(worktree, ['remote', 'add', 'origin', 'https://github.com/acme/private-widget.git']);

    // Real git, real env wiring: the session env alone must make git resolve
    // the URL-scoped helper config. HOME/NOSYSTEM pin out every ambient
    // credential source — exactly what the OS sandbox masks do in production.
    const configProbe = spawnSync('git', ['config', '--get', GIT_READ_TOKEN_URL_SCOPE], {
      cwd: worktree,
      encoding: 'utf8',
      env: { ...minimalEnv(fakeEntrypoint), ...wiring.env },
    });
    expect(configProbe.status).toBe(0);
    expect(configProbe.stdout.trim()).toBe(wiring.helperPath);

    // And executing the helper through git's own credential protocol yields
    // parseable credentials (this is exactly what a `git fetch` would consume).
    const fill = spawnSync('git', ['credential', 'fill'], {
      cwd: worktree,
      encoding: 'utf8',
      env: { ...minimalEnv(fakeEntrypoint), ...wiring.env },
      input: 'protocol=https\nhost=github.com\n\n',
    });
    expect(fill.status, fill.stderr).toBe(0);
    expect(fill.stdout).toContain('username=x-access-token');
    expect(fill.stdout).toContain('password=ro-token-123');
  });

  function run(cwd: string, args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }

  describe('resolveBeelineCliEntrypoint', () => {
    it('accepts built JS entrypoints and rejects dev/ts sources', () => {
      expect(resolveBeelineCliEntrypoint(['node', '/opt/b/beeline-cli.mjs'])).toBe(
        '/opt/b/beeline-cli.mjs',
      );
      expect(resolveBeelineCliEntrypoint(['node', '/opt/b/cli.js'])).toBe('/opt/b/cli.js');
      expect(resolveBeelineCliEntrypoint(['tsx', '/repo/src/cli.ts'])).toBeUndefined();
      expect(resolveBeelineCliEntrypoint(['node'])).toBeUndefined();
      expect(resolveBeelineCliEntrypoint([])).toBeUndefined();
    });
  });
});

function minimalEnv(home: string): Record<string, string> {
  // A private HOME plus GIT_CONFIG_NOSYSTEM reproduce the sandbox property
  // this feature relies on: no ambient credential helper or store can answer
  // before ours.
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
  };
}
