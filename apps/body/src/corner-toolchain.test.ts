/**
 * Corner-local dependency provisioning regression coverage. These tests use
 * real git worktrees and npm installs at the same boundary as Body.createWorktree.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  cornerToolchainNotice,
  ensureCornerToolchainProvisioned,
  toolchainProvisionSteps,
} from './corner-toolchain.js';

function run(cwd: string, command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

function git(cwd: string, args: string[]) {
  return run(cwd, 'git', args);
}

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspaceFixture(): Promise<{ checkout: string; worktree: string }> {
  const root = await tempRoot('corner-toolchain-workspace-');
  const checkout = resolve(root, 'canonical');
  const worktree = resolve(root, 'corners', 'c1');
  expect(git(root, ['init', '-q', '-b', 'main', 'canonical']).status).toBe(0);
  git(checkout, ['config', 'user.email', 'op@beeline.local']);
  git(checkout, ['config', 'user.name', 'operator']);

  await mkdir(resolve(checkout, 'packages', 'app'), { recursive: true });
  await mkdir(resolve(checkout, 'packages', 'lib'), { recursive: true });
  await mkdir(resolve(checkout, 'packages', 'typescript', 'bin'), { recursive: true });
  await mkdir(resolve(checkout, 'packages', 'vitest', 'bin'), { recursive: true });
  await writeFile(
    resolve(checkout, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      private: true,
      workspaces: ['packages/*'],
      scripts: { build: 'npm run build -w @fixture/app' },
      devDependencies: { typescript: '1.0.0', vitest: '1.0.0' },
    }),
  );
  await writeFile(
    resolve(checkout, 'packages', 'app', 'package.json'),
    JSON.stringify({
      name: '@fixture/app',
      version: '1.0.0',
      scripts: { build: 'tsc' },
      dependencies: { '@fixture/lib': '1.0.0' },
    }),
  );
  await writeFile(
    resolve(checkout, 'packages', 'lib', 'package.json'),
    JSON.stringify({ name: '@fixture/lib', version: '1.0.0', main: 'index.js' }),
  );
  await writeFile(
    resolve(checkout, 'packages', 'lib', 'index.js'),
    "module.exports = 'canonical';\n",
  );
  await writeFile(
    resolve(checkout, 'packages', 'typescript', 'package.json'),
    JSON.stringify({ name: 'typescript', version: '1.0.0', bin: { tsc: 'bin/tsc.js' } }),
  );
  await writeFile(
    resolve(checkout, 'packages', 'typescript', 'bin', 'tsc.js'),
    "#!/usr/bin/env node\nconsole.log('fixture tsc');\n",
    { mode: 0o755 },
  );
  await writeFile(
    resolve(checkout, 'packages', 'vitest', 'package.json'),
    JSON.stringify({ name: 'vitest', version: '1.0.0', bin: { vitest: 'bin/vitest.js' } }),
  );
  await writeFile(
    resolve(checkout, 'packages', 'vitest', 'bin', 'vitest.js'),
    "#!/usr/bin/env node\nconsole.log('fixture vitest');\n",
    { mode: 0o755 },
  );

  const lock = run(checkout, 'npm', [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);
  expect(lock.status, lock.stderr).toBe(0);
  await writeFile(resolve(checkout, '.gitignore'), 'node_modules\n');
  expect(git(checkout, ['add', '.']).status).toBe(0);
  expect(git(checkout, ['commit', '-qm', 'fixture']).status).toBe(0);
  expect(git(checkout, ['worktree', 'add', '-b', 'feature/c1', worktree, 'main']).status).toBe(0);
  return { checkout, worktree };
}

describe('ensureCornerToolchainProvisioned', () => {
  it('installs a fresh workspace worktree with local bins and corner-owned workspace links', async () => {
    const { checkout, worktree } = await createWorkspaceFixture();
    expect(existsSync(resolve(worktree, 'node_modules'))).toBe(false);

    const result = ensureCornerToolchainProvisioned(worktree, () => undefined);

    expect(result).toEqual({ status: 'ready' });
    expect(existsSync(resolve(worktree, 'node_modules', '.bin', 'tsc'))).toBe(true);
    expect(existsSync(resolve(worktree, 'node_modules', '.bin', 'vitest'))).toBe(true);
    expect(realpathSync(resolve(worktree, 'node_modules', '@fixture', 'lib'))).toBe(
      resolve(worktree, 'packages', 'lib'),
    );
    expect(realpathSync(resolve(worktree, 'node_modules', '@fixture', 'lib'))).not.toBe(
      resolve(checkout, 'packages', 'lib'),
    );

    await writeFile(
      resolve(worktree, 'packages', 'lib', 'index.js'),
      "module.exports = 'corner';\n",
    );
    const resolveEditedWorkspace = run(worktree, 'node', [
      '-e',
      "process.stdout.write(require('@fixture/lib'))",
    ]);
    expect(resolveEditedWorkspace.status, resolveEditedWorkspace.stderr).toBe(0);
    expect(resolveEditedWorkspace.stdout).toBe('corner');

    const build = run(worktree, 'npm', ['run', 'build']);
    expect(build.status, build.stderr).toBe(0);
    expect(build.stdout).toContain('fixture tsc');
    const vitest = run(worktree, resolve(worktree, 'node_modules', '.bin', 'vitest'), [
      '--version',
    ]);
    expect(vitest.status, vitest.stderr).toBe(0);
    expect(vitest.stdout).toContain('fixture vitest');
  });

  it('replaces a legacy shared node_modules link with a corner-local install', async () => {
    const { checkout, worktree } = await createWorkspaceFixture();
    const canonicalInstall = run(checkout, 'npm', ['ci', '--ignore-scripts']);
    expect(canonicalInstall.status, canonicalInstall.stderr).toBe(0);
    await symlink(resolve(checkout, 'node_modules'), resolve(worktree, 'node_modules'), 'dir');
    expect(realpathSync(resolve(worktree, 'node_modules', '@fixture', 'lib'))).toBe(
      resolve(checkout, 'packages', 'lib'),
    );

    const result = ensureCornerToolchainProvisioned(worktree, () => undefined);

    expect(result).toEqual({ status: 'ready' });
    expect(realpathSync(resolve(worktree, 'node_modules', '@fixture', 'lib'))).toBe(
      resolve(worktree, 'packages', 'lib'),
    );
  });

  it('is a clean no-op for a repository without package.json', async () => {
    const root = await tempRoot('corner-toolchain-no-node-');
    const logs: string[] = [];
    expect(ensureCornerToolchainProvisioned(root, (line) => logs.push(line))).toEqual({
      status: 'noop',
    });
    expect(toolchainProvisionSteps(root)).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('leaves an explicitly different Node package manager alone', async () => {
    const root = await tempRoot('corner-toolchain-pnpm-');
    await writeFile(resolve(root, 'package.json'), '{"packageManager":"pnpm@10.0.0"}\n');
    await writeFile(resolve(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const logs: string[] = [];

    expect(ensureCornerToolchainProvisioned(root, (line) => logs.push(line))).toEqual({
      status: 'noop',
    });
    expect(existsSync(resolve(root, 'node_modules'))).toBe(false);
    expect(logs).toEqual([]);
  });

  it('installs an npm project without adding a lockfile to the corner', async () => {
    const root = await tempRoot('corner-toolchain-unlocked-npm-');
    await writeFile(resolve(root, 'package.json'), '{"private":true}\n');

    expect(ensureCornerToolchainProvisioned(root, () => undefined)).toEqual({ status: 'ready' });
    expect(existsSync(resolve(root, 'package-lock.json'))).toBe(false);
    expect(existsSync(resolve(root, 'node_modules', '.beeline-provisioned'))).toBe(true);
  });

  it('reports one cached actionable failure instead of retrying a 127-style loop', async () => {
    const root = await tempRoot('corner-toolchain-failure-');
    await writeFile(
      resolve(root, 'package.json'),
      '{"dependencies":{"missing-from-lock":"1.0.0"}}\n',
    );
    await writeFile(resolve(root, 'package-lock.json'), '{}\n');
    const logs: string[] = [];

    const first = ensureCornerToolchainProvisioned(root, (line) => logs.push(line));
    const second = ensureCornerToolchainProvisioned(root, (line) => logs.push(line));

    expect(first.status).toBe('failed');
    expect(second).toEqual(first);
    expect(logs.filter((line) => line.startsWith('Toolchain setup failed'))).toHaveLength(1);
    expect(cornerToolchainNotice(root)).toContain('retry `npm ci`');
    expect(cornerToolchainNotice(root)).toContain('The corner is still usable');
  });
});

describe('toolchainProvisionSteps', () => {
  it('installs dependencies before Beeline workspace builds', async () => {
    const root = await tempRoot('provision-steps-');
    await mkdir(resolve(root, 'apps/mobile'), { recursive: true });
    // Mere directory existence is the production failure shape: an incomplete
    // install has neither npm's inventory nor the expected .bin executables.
    await mkdir(resolve(root, 'node_modules'), { recursive: true });
    await mkdir(resolve(root, 'apps/mobile/node_modules'), { recursive: true });
    await mkdir(resolve(root, 'packages/nostr/src'), { recursive: true });
    await mkdir(resolve(root, 'packages/buzz-client/src'), { recursive: true });
    await writeFile(resolve(root, 'package.json'), '{}\n');
    await writeFile(resolve(root, 'package-lock.json'), '{}\n');
    await writeFile(resolve(root, 'apps/mobile/package.json'), '{}\n');
    await writeFile(resolve(root, 'packages/nostr/package.json'), '{"name":"@beeline/nostr"}\n');
    await writeFile(
      resolve(root, 'packages/buzz-client/package.json'),
      '{"name":"@beeline/buzz-client"}\n',
    );

    expect(toolchainProvisionSteps(root).map((step) => step.label)).toEqual([
      'npm ci (root)',
      'npm install (apps/mobile)',
      'build @beeline/nostr',
      'build @beeline/buzz-client',
    ]);
  });
});
