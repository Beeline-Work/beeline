import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { git, gitWithInstallationToken, gitWithUserCredentials } from './git.js';

const cleanup: string[] = [];
const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;

afterEach(async () => {
  if (originalGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.sequential('git credential boundaries', () => {
  it('uses the operator global credential helper only on the ambient-user path', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'beeline-git-user-'));
    cleanup.push(dir);
    const config = resolve(dir, 'user.gitconfig');
    await writeFile(config, '[credential]\n\thelper = test-user-helper\n');
    process.env.GIT_CONFIG_GLOBAL = config;

    const ambient = await gitWithUserCredentials(dir, [
      'config',
      '--global',
      '--get',
      'credential.helper',
    ]);
    expect(ambient.ok, ambient.stderr).toBe(true);
    expect(ambient.stdout.trim()).toBe('test-user-helper');

    const isolated = await git(dir, ['config', '--global', '--get', 'credential.helper']);
    expect(isolated.stdout.trim()).toBe('');
  });

  it('injects a GitHub App token while keeping ambient credential helpers disabled', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'beeline-git-installation-'));
    cleanup.push(dir);
    const config = resolve(dir, 'user.gitconfig');
    await writeFile(config, '[credential]\n\thelper = forbidden-ambient-helper\n');
    process.env.GIT_CONFIG_GLOBAL = config;

    const result = await gitWithInstallationToken(dir, 'short-lived-token', [
      'config',
      '--get-regexp',
      '^(credential\\.helper|http\\.extraHeader)$',
    ]);
    expect(result.ok, result.stderr).toBe(true);
    expect(result.stdout).toContain('credential.helper');
    expect(result.stdout).not.toContain('forbidden-ambient-helper');
    expect(result.stdout).toContain(
      `Authorization: Basic ${Buffer.from('x-access-token:short-lived-token').toString('base64')}`,
    );
  });

  it('kills the whole Git process group when its hard deadline expires', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'beeline-git-timeout-'));
    cleanup.push(dir);
    const helper = resolve(dir, 'git');
    await writeFile(helper, '#!/bin/sh\ntrap "" TERM\n(sleep 30) &\nwait\n', { mode: 0o755 });
    const previousGitBinary = process.env.BEELINE_GIT_BINARY;
    process.env.BEELINE_GIT_BINARY = helper;
    try {
      const startedAt = Date.now();
      const result = await git(dir, ['status'], { timeoutMs: 50, killGraceMs: 50 });
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.stderr).toContain('git deadline exceeded');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      if (previousGitBinary === undefined) delete process.env.BEELINE_GIT_BINARY;
      else process.env.BEELINE_GIT_BINARY = previousGitBinary;
    }
  });

  it('honors an already-aborted caller signal without racing worker listeners', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'beeline-git-abort-'));
    cleanup.push(dir);
    const controller = new AbortController();
    controller.abort();
    const result = await git(dir, ['status'], { signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.stderr).toContain('git operation aborted');
  });
});
