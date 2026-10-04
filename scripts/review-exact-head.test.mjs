import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isMobilePackage,
  parseReviewArgs,
  reviewExactHead,
  REVIEW_BUILD_PACKAGES,
} from './review-exact-head.mjs';

const SHA = 'a'.repeat(40);

function fakeDeps(overrides = {}) {
  const calls = { run: [], git: [] };
  const makeTemp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-exact-head-test-'));
    calls.tempDir = dir;
    return dir;
  };
  const remove = (dir) => {
    calls.removed = dir;
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    calls,
    deps: {
      makeTemp,
      remove,
      log: () => {},
      git: (args) => {
        calls.git.push(args);
        const res = overrides.git ? overrides.git(args) : undefined;
        return res ?? { status: 0, stdout: SHA, stderr: '' };
      },
      run: (command, args) => {
        calls.run.push([command, args]);
        const res = overrides.run ? overrides.run(command, args) : undefined;
        return res ?? { status: 0, stdout: '', stderr: '' };
      },
    },
  };
}

test('parseReviewArgs requires a full 40-hex sha', () => {
  assert.throws(() => parseReviewArgs([]), /missing <sha>/);
  assert.throws(() => parseReviewArgs(['abc']), /full 40-hex/);
  assert.throws(() => parseReviewArgs([SHA, '--nope']), /unknown option/);
  assert.throws(() => parseReviewArgs([SHA, 'src/integration.test.ts']), /<pkg>:<glob>/);
  assert.throws(() => parseReviewArgs([SHA, '--typecheck']), /needs a package name/);
});

test('parseReviewArgs splits typechecks, targets and keep', () => {
  const parsed = parseReviewArgs([
    SHA,
    '--typecheck',
    '@beeline/server',
    '--typecheck',
    '@beeline/body',
    '--keep',
    '--',
    '@beeline/server:src/integration.test.ts',
    '@beeline/body:src/beeline-skill.test.ts',
  ]);
  assert.deepEqual(parsed, {
    sha: SHA,
    typechecks: ['@beeline/server', '@beeline/body'],
    targets: [
      '@beeline/server:src/integration.test.ts',
      '@beeline/body:src/beeline-skill.test.ts',
    ],
    keep: true,
  });
});

test('resolves, checks out, installs, builds exports, runs steps and cleans up', () => {
  const { calls, deps } = fakeDeps();
  const result = reviewExactHead(
    [
      SHA,
      '--typecheck',
      '@beeline/server',
      '--',
      '@beeline/server:src/integration.test.ts',
      '@beeline/body:src/beeline-skill.test.ts',
    ],
    deps,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls.git[0], ['rev-parse', '--verify', '--quiet', `${SHA}^{commit}`]);
  assert.deepEqual(calls.git[1], ['worktree', 'add', '--detach', calls.tempDir, SHA]);
  assert.deepEqual(calls.run[0], ['npm', ['ci']]);
  const buildArgs = ['run', 'build'];
  for (const pkg of REVIEW_BUILD_PACKAGES) buildArgs.push('-w', pkg);
  assert.deepEqual(calls.run[1], ['npm', buildArgs]);
  assert.deepEqual(calls.run[2], ['npm', ['run', 'typecheck', '-w', '@beeline/server']]);
  assert.deepEqual(calls.run[3], [
    'npm',
    ['test', '-w', '@beeline/server', '--', '--run', 'src/integration.test.ts'],
  ]);
  assert.deepEqual(calls.run[4], [
    'npm',
    ['test', '-w', '@beeline/body', '--', '--run', 'src/beeline-skill.test.ts'],
  ]);
  assert.deepEqual(calls.git[calls.git.length - 1], ['worktree', 'remove', '--force', calls.tempDir]);
  assert.equal(calls.removed, undefined);
});

test('a failing step fails the summary with that step named', () => {
  const { calls, deps } = fakeDeps({
    run: (command, args) =>
      command === 'npm' && args[0] === 'ci' ? { status: 7, stdout: '', stderr: '' } : undefined,
  });
  const result = reviewExactHead([SHA, '--', '@beeline/server:src/integration.test.ts'], deps);
  assert.equal(result.ok, false);
  assert.equal(result.failed.name, 'npm ci');
  assert.deepEqual(calls.git[calls.git.length - 1], ['worktree', 'remove', '--force', calls.tempDir]);
});

test('recognizes the mobile app spellings that need --prefix, not -w', () => {
  assert.equal(isMobilePackage('@beeline/mobile'), true);
  assert.equal(isMobilePackage('mobile'), true);
  assert.equal(isMobilePackage('apps/mobile'), true);
  assert.equal(isMobilePackage('@beeline/server'), false);
});

test('runs mobile install, typecheck and tests with --prefix apps/mobile', () => {
  const { calls, deps } = fakeDeps();
  const result = reviewExactHead(
    [
      SHA,
      '--typecheck',
      '@beeline/mobile',
      '--',
      '@beeline/mobile:sources/buzz/calm-lint',
    ],
    deps,
  );
  assert.equal(result.ok, true);
  const npm = calls.run.filter(([command]) => command === 'npm');
  assert.deepEqual(npm[0], ['npm', ['ci']]);
  assert.deepEqual(npm[1], ['npm', ['ci', '--prefix', 'apps/mobile']]);
  assert.deepEqual(
    npm.find(([, args]) => args[0] === 'run' && args.includes('typecheck')),
    ['npm', ['run', 'typecheck', '--prefix', 'apps/mobile']],
  );
  assert.deepEqual(
    npm.find(([, args]) => args[0] === 'test'),
    ['npm', ['test', '--prefix', 'apps/mobile', '--', '--run', 'sources/buzz/calm-lint']],
  );
});

test('does not install the mobile tree for non-mobile targets', () => {
  const { calls, deps } = fakeDeps();
  reviewExactHead([SHA, '--', '@beeline/server:src/integration.test.ts'], deps);
  assert.ok(!calls.run.some(([, args]) => args.includes('apps/mobile')));
});

test('an unresolvable head fails prepare and attempts no cleanup', () => {
  const { calls, deps } = fakeDeps({
    git: (args) => (args[0] === 'rev-parse' ? { status: 128, stdout: '', stderr: 'unknown' } : undefined),
  });
  const result = reviewExactHead([SHA], deps);
  assert.equal(result.ok, false);
  assert.equal(result.failed.name, 'prepare');
  assert.equal(calls.git.length, 1);
  assert.equal(calls.tempDir, undefined);
});

test('a worktree that refuses removal is deleted and pruned', () => {
  const { calls, deps } = fakeDeps({
    git: (args) =>
      args[0] === 'worktree' && args[1] === 'remove'
        ? { status: 1, stdout: '', stderr: 'not empty' }
        : undefined,
  });
  const result = reviewExactHead([SHA], deps);
  assert.equal(result.ok, true);
  assert.equal(calls.removed, calls.tempDir);
  assert.deepEqual(calls.git[calls.git.length - 1], ['worktree', 'prune']);
});

test('--keep leaves the worktree and prints the removal command', () => {
  const { calls, deps } = fakeDeps();
  const logs = [];
  const result = reviewExactHead([SHA, '--keep'], {
    ...deps,
    log: (line) => logs.push(line),
  });
  assert.equal(result.ok, true);
  assert.equal(existsSync(calls.tempDir), true);
  assert.ok(
    logs.some((line) => line === `[review] kept; remove with: git worktree remove --force ${calls.tempDir}`),
  );
  rmSync(calls.tempDir, { recursive: true, force: true });
});
