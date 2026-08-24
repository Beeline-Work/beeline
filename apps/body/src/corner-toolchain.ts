/**
 * Corner worktree toolchain — install a fresh corner's dependency tree before
 * its agent can run repository build/test commands.
 *
 * A git worktree contains tracked files only, so it starts without
 * `node_modules`. Sharing the canonical checkout's root dependency directory
 * looks cheap, but is incorrect for npm workspaces: links such as
 * `node_modules/@beeline/nostr` then resolve to the canonical checkout's
 * `packages/nostr`, not the corner's edited package.
 *
 * Provision each corner in place instead. `npm ci` still reuses npm's
 * content-addressed cache, while npm creates workspace links relative to the
 * corner and automatically exposes `node_modules/.bin` to every `npm run`
 * script. Repositories without a package.json are a clean no-op. Every command
 * is bounded and best-effort: a failure is cached for the daemon process,
 * logged once, and exposed to the corner as one actionable notice.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ProvisionStep {
  label: string;
  cwd?: string;
  args: string[];
}

export type ToolchainProvisionResult =
  { status: 'noop' } | { status: 'ready' } | { status: 'failed'; message: string };

/** One provisioning result per corner worktree per daemon process. */
const provisionRuns = new Map<string, ToolchainProvisionResult>();

const PROVISION_TIMEOUT_MS = 15 * 60 * 1000;
const PROVISION_SENTINEL = '.beeline-provisioned';

function isNpmPackageRoot(packageRoot: string): boolean {
  const packageJson = resolve(packageRoot, 'package.json');
  if (!existsSync(packageJson)) return false;
  try {
    const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { packageManager?: unknown };
    if (
      typeof manifest.packageManager === 'string' &&
      !/^npm(?:@|$)/.test(manifest.packageManager)
    ) {
      return false;
    }
  } catch {
    return false;
  }
  if (existsSync(resolve(packageRoot, 'package-lock.json'))) return true;
  return !['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some((lock) =>
    existsSync(resolve(packageRoot, lock)),
  );
}

function dependencyTreeNeedsInstall(packageRoot: string): boolean {
  const nodeModules = resolve(packageRoot, 'node_modules');
  try {
    // Repair links left by the old shared-node_modules strategy. Even a valid
    // canonical tree has workspace links pointing at canonical package source.
    if (lstatSync(nodeModules).isSymbolicLink()) return true;
  } catch {
    return true;
  }

  // npm writes this inventory only after a completed modern install. A bare
  // directory (the production failure shape) is not proof that tsc/vitest or
  // any other declared dependency is actually present.
  return ![
    resolve(nodeModules, '.package-lock.json'),
    resolve(nodeModules, PROVISION_SENTINEL),
  ].some(existsSync);
}

/**
 * Pure decision half of {@link ensureCornerToolchainProvisioned}: which
 * installs/builds this corner still needs. Empty for non-Node repositories and
 * for already-complete worktrees.
 */
export function toolchainProvisionSteps(worktreeRoot: string): ProvisionStep[] {
  const steps: ProvisionStep[] = [];
  if (!isNpmPackageRoot(worktreeRoot)) return steps;

  const hasLock = existsSync(resolve(worktreeRoot, 'package-lock.json'));
  if (dependencyTreeNeedsInstall(worktreeRoot)) {
    steps.push({
      label: hasLock ? 'npm ci (root)' : 'npm install (root)',
      args: hasLock ? ['ci'] : ['install', '--package-lock=false', '--no-audit', '--no-fund'],
    });
  }

  // Beeline's Expo app has its own lockfile and is intentionally outside the
  // root npm workspace. Treat it as a second package root when present.
  const mobile = resolve(worktreeRoot, 'apps', 'mobile');
  if (isNpmPackageRoot(mobile) && dependencyTreeNeedsInstall(mobile)) {
    const mobileHasLock = existsSync(resolve(mobile, 'package-lock.json'));
    steps.push({
      label: mobileHasLock ? 'npm ci (apps/mobile)' : 'npm install (apps/mobile)',
      cwd: 'apps/mobile',
      args: mobileHasLock ? ['ci'] : ['install', '--package-lock=false', '--no-audit', '--no-fund'],
    });
  }

  // Mobile resolves these packages through their built dist directories.
  // These builds run only after the root install above, so npm supplies the
  // corner-local node_modules/.bin on PATH to `tsc` and other scripts.
  for (const workspace of ['@beeline/nostr', '@beeline/buzz-client']) {
    const pkgName = workspace.replace('@beeline/', '');
    if (
      existsSync(resolve(worktreeRoot, 'packages', pkgName, 'package.json')) &&
      !existsSync(resolve(worktreeRoot, 'packages', pkgName, 'dist', 'index.js'))
    ) {
      steps.push({ label: `build ${workspace}`, args: ['run', 'build', '-w', workspace] });
    }
  }
  return steps;
}

function lastDiagnostic(result: ReturnType<typeof spawnSync>): string {
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (output) return output;
  if (result.error) return result.error.message;
  return 'the command produced no diagnostic output';
}

/**
 * Provision one corner worktree synchronously before its edit session starts.
 * Failures never abort corner creation and are reported only once per daemon
 * process; the returned notice tells the agent exactly which command to retry.
 */
export function ensureCornerToolchainProvisioned(
  worktreeRoot: string,
  log?: (line: string) => void,
): ToolchainProvisionResult {
  const key = resolve(worktreeRoot);
  const existing = provisionRuns.get(key);
  if (existing) return existing;

  const steps = toolchainProvisionSteps(key);
  if (!steps.length) return { status: 'noop' };

  const say = log ?? ((line: string) => console.log(`[body] ${line}`));
  for (const step of steps) {
    const cwd = step.cwd ? resolve(key, step.cwd) : key;
    say(`toolchain provisioning ${step.label} in ${key}`);
    const result = spawnSync('npm', step.args, {
      cwd,
      encoding: 'utf8',
      timeout: PROVISION_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.status !== 0) {
      const command = `npm ${step.args.join(' ')}`;
      const message =
        `Toolchain setup failed at ${step.label} (exit ${result.status ?? 'signal'}): ` +
        `${lastDiagnostic(result)}. The corner is still usable; retry \`${command}\` from ${cwd}.`;
      const failed: ToolchainProvisionResult = { status: 'failed', message };
      provisionRuns.set(key, failed);
      say(message);
      return failed;
    }
    if (step.args[0] === 'ci' || step.args[0] === 'install') {
      try {
        const nodeModules = resolve(cwd, 'node_modules');
        mkdirSync(nodeModules, { recursive: true });
        writeFileSync(resolve(nodeModules, PROVISION_SENTINEL), '');
      } catch {
        // The install itself succeeded. A missing optimization sentinel may
        // cause a later daemon process to install again, but never blocks now.
      }
    }
  }

  const ready: ToolchainProvisionResult = { status: 'ready' };
  provisionRuns.set(key, ready);
  say(`toolchain provisioning done for ${key}`);
  return ready;
}

/** One prompt-safe failure line for a corner whose automatic setup failed. */
export function cornerToolchainNotice(worktreeRoot: string): string | undefined {
  const result = provisionRuns.get(resolve(worktreeRoot));
  return result?.status === 'failed' ? result.message : undefined;
}
