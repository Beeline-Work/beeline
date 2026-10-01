#!/usr/bin/env node
/**
 * Deterministic exact-head review bootstrap.
 *
 * Checks one exact commit out into a temporary detached worktree, installs
 * from the committed lockfile, builds every workspace package export the
 * server/body/gate/push-gateway tests consume, then runs the requested
 * non-interactive typechecks and targeted tests and prints a per-step
 * PASS/FAIL summary. The worktree is removed on exit unless `--keep` is
 * passed, in which case the removal command is printed instead.
 *
 * Usage:
 *   node scripts/review-exact-head.mjs <sha>
 *       Prepare the worktree and print its path; run further commands by hand.
 *   node scripts/review-exact-head.mjs <sha> -- <pkg>:<glob> [<pkg>:<glob> ...]
 *       Also run `npm test -w <pkg> -- --run <glob>` for each target.
 *   node scripts/review-exact-head.mjs <sha> --typecheck <pkg> [--typecheck <pkg> ...]
 *       Also run each package's `npm run typecheck`.
 *
 * <sha> must be a full 40-hex commit id: an exact-head review is pinned to one
 * commit, never a branch that could move. Targets are package-qualified vitest
 * files/globs, e.g. `@beeline/server:src/integration.test.ts`.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  node scripts/review-exact-head.mjs <sha> [--typecheck <pkg> ...] [--keep] [--] [<pkg>:<glob> ...]
`;

/** Packages whose dist/ exports the server/body/gate/push-gateway tests import. */
export const REVIEW_BUILD_PACKAGES = [
  '@beeline/nostr',
  '@beeline/api-contract',
  '@beeline/buzz-client',
  '@beeline/gate',
  '@beeline/auth',
  '@beeline/body',
  '@beeline/push-gateway',
];

export function parseReviewArgs(argv) {
  const positional = [];
  const typechecks = [];
  let keep = false;
  let afterDash = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (afterDash) {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      afterDash = true;
      continue;
    }
    if (arg === '--keep') {
      keep = true;
      continue;
    }
    if (arg === '--typecheck') {
      const pkg = argv[i + 1];
      if (!pkg) {
        throw new Error(`${USAGE}\n--typecheck needs a package name`);
      }
      typechecks.push(pkg);
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`${USAGE}\nunknown option: ${arg}`);
    }
    positional.push(arg);
  }
  const sha = positional.shift();
  if (!sha) {
    throw new Error(`${USAGE}\nmissing <sha>`);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`<sha> must be a full 40-hex commit id, got: ${sha}`);
  }
  for (const target of positional) {
    if (!target.includes(':')) {
      throw new Error(`${USAGE}\ntarget must be <pkg>:<glob>, got: ${target}`);
    }
  }
  return { sha, typechecks, targets: positional, keep };
}

function defaultRun(command, args, opts) {
  const result = spawnSync(command, args, { cwd: opts.cwd, stdio: 'inherit' });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function defaultGit(args) {
  const result = spawnSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').toString().trim(),
    stderr: (result.stderr ?? '').toString().trim(),
  };
}

export function reviewExactHead(argv, deps = {}) {
  const {
    run = defaultRun,
    git = defaultGit,
    makeTemp = () => mkdtempSync(join(tmpdir(), 'beeline-review-')),
    remove = (dir) => rmSync(dir, { recursive: true, force: true }),
    log = (line) => process.stdout.write(`${line}\n`),
  } = deps;

  const { sha, typechecks, targets, keep } = parseReviewArgs(argv);
  const verdicts = [];
  let worktreeDir = null;

  const note = (name, status, detail = '') => {
    verdicts.push({ name, status, detail });
    log(`[review] ${status ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const cleanup = () => {
    if (!worktreeDir) return;
    if (git(['worktree', 'remove', '--force', worktreeDir]).status === 0) {
      log('[review] worktree removed');
      return;
    }
    remove(worktreeDir);
    git(['worktree', 'prune']);
    log('[review] worktree directory removed and pruned');
  };

  try {
    const resolved = git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    if (resolved.status !== 0 || !/^[0-9a-f]{40}$/.test(resolved.stdout)) {
      throw new Error(`head ${sha} does not resolve to a commit in this repository`);
    }
    const head = resolved.stdout;
    log(`[review] head ${head}`);

    worktreeDir = makeTemp();
    const add = git(['worktree', 'add', '--detach', worktreeDir, head]);
    if (add.status !== 0) {
      throw new Error(`git worktree add failed: ${add.stderr || add.stdout}`);
    }
    log(`[review] worktree ${worktreeDir}`);

    const install = run('npm', ['ci'], { cwd: worktreeDir });
    note('npm ci', install.status === 0, install.status === 0 ? '' : `exit ${install.status}`);

    const buildArgs = ['run', 'build'];
    for (const pkg of REVIEW_BUILD_PACKAGES) {
      buildArgs.push('-w', pkg);
    }
    const build = run('npm', buildArgs, { cwd: worktreeDir });
    note(
      'build workspace exports',
      build.status === 0,
      build.status === 0 ? '' : `exit ${build.status}`,
    );

    for (const pkg of typechecks) {
      const step = run('npm', ['run', 'typecheck', '-w', pkg], { cwd: worktreeDir });
      note(`typecheck ${pkg}`, step.status === 0, step.status === 0 ? '' : `exit ${step.status}`);
    }

    for (const target of targets) {
      const [pkg, glob] = target.split(':');
      const step = run('npm', ['test', '-w', pkg, '--', '--run', glob], { cwd: worktreeDir });
      note(`test ${pkg} ${glob}`, step.status === 0, step.status === 0 ? '' : `exit ${step.status}`);
    }

    if (keep) {
      log(`[review] kept; remove with: git worktree remove --force ${worktreeDir}`);
    }
  } catch (err) {
    note('prepare', false, err.message);
  } finally {
    if (!keep) {
      cleanup();
    }
  }

  const failed = verdicts.find((step) => !step.status);
  if (failed) {
    log(`[review] summary: FAIL at ${failed.name}`);
    return { ok: false, verdicts, failed };
  }
  log('[review] summary: PASS');
  return { ok: true, verdicts };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = reviewExactHead(process.argv.slice(2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
