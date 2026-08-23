/**
 * Corner worktree toolchain — give a fresh corner the dependency tree its
 * repository's build/test commands assume.
 *
 * A corner worktree is a plain `git worktree add`, which carries no untracked
 * files: `node_modules` never comes along. The live failure record (2026-08-23
 * owner report, 110 failed tool calls across 10 corners) is dominated by the
 * consequence — `sh: 1: vitest: not found`, `tsc: not found`,
 * `turbo: not found`, `npm error No workspaces found`, and `Cannot find module
 * '@beeline/buzz-client'` storms, roughly half of all failures — with the agent
 * retrying variants of the same doomed command instead of doing its task.
 *
 * Two halves, both best-effort (a missing or broken toolchain must never block
 * or abort a corner — the corner just sees honest command failures):
 *
 *   - {@link ensureCheckoutToolchainProvisioned}: install dependencies ONCE per
 *     canonical checkout per daemon process (`npm ci` at the root and in an
 *     isolated `apps/mobile`, then build the file-linked `@beeline/*` dists the
 *     mobile suite resolves through). Fire-and-forget; a later corner picks up
 *     the finished result.
 *
 *   - {@link seedCornerNodeModules}: link what exists into a fresh worktree —
 *     the root `node_modules` plus each first-level workspace member's own, so
 *     `npm test --prefix apps/mobile` and root `vitest -w` both resolve.
 *     Symlinks (not copies): cheap, always fresh, and writes through them land
 *     in the shared checkout exactly like the operator's own workflow. The
 *     links are added to the worktree's own `info/exclude` so `git status`
 *     stays clean even in repositories that do not ignore `node_modules`.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface SeedResult {
  /** Worktree-relative paths that now link into the source checkout. */
  linked: string[];
}

// No trailing slash: git treats a symlink as a FILE, so `node_modules/`
// (directory-only) would never match the seeded link itself.
const EXCLUDE_ENTRY = 'node_modules';

/**
 * Link the source checkout's `node_modules` directories into a fresh corner
 * worktree. Idempotent: existing entries (real directories or earlier links)
 * are left untouched, missing sources are skipped, and any single failure is
 * contained. Never deletes anything.
 *
 * Discovery runs on the SOURCE side (where are its dependency roots?) and maps
 * onto the worktree, because the two trees share their layout but only one has
 * dependencies installed. Covers the root plus nested workspace members down
 * to `apps/mobile`-style depth.
 */
export function seedCornerNodeModules(input: {
  worktreePath: string;
  sourceCheckout: string;
}): SeedResult {
  const linked: string[] = [];
  if (!input.sourceCheckout || !existsSync(input.sourceCheckout)) return { linked };

  for (const rel of sourceNodeModuleRoots(input.sourceCheckout)) {
    try {
      const target = resolve(input.sourceCheckout, rel, 'node_modules');
      const linkParent = resolve(input.worktreePath, rel);
      if (!existsSync(linkParent)) continue;
      const linkPath = resolve(linkParent, 'node_modules');
      if (existsSync(linkPath) || hasSymlink(linkPath)) continue;
      symlinkSync(target, linkPath, 'dir');
      linked.push(rel === '.' ? 'node_modules' : `${rel}/node_modules`);
    } catch {
      // Best effort: one unseedable directory never blocks the rest.
    }
  }

  if (linked.length) excludeFromWorktreeStatus(input.worktreePath);
  return { linked };
}

/** How deep below the checkout root dependency roots are discovered. */
const NODE_MODULES_SCAN_DEPTH = 2;

/**
 * Worktree-relative directories of the source checkout that hold a real
 * `node_modules`: the root (`.`), then nested package roots like
 * `apps/mobile`. Deliberately shallow — a bounded number of `stat`s per
 * level, never a full recursive walk of the checkout.
 */
function sourceNodeModuleRoots(sourceCheckout: string): string[] {
  const roots: string[] = [];
  const visit = (rel: string, depth: number): void => {
    if (existsSync(resolve(sourceCheckout, rel, 'node_modules'))) roots.push(rel);
    if (depth >= NODE_MODULES_SCAN_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(resolve(sourceCheckout, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      visit(rel === '.' ? entry.name : `${rel}/${entry.name}`, depth + 1);
    }
  };
  visit('.', 0);
  return roots;
}

function hasSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// ── One-time provisioning of the canonical checkout ──────────────────────────

interface ProvisionStep {
  label: string;
  cwd?: string;
  args: string[];
}

/** Keep the seed links out of `git status` even without a .gitignore entry. */
function excludeFromWorktreeStatus(worktreePath: string): void {
  try {
    // Same channel as agent-private-state's excludeBodyOwnedLink: the repo's
    // shared info/exclude. Best-effort — merge readiness independently ignores
    // these links via projectDirtyStatus's symlink check.
    const gitPath = spawnSync(
      'git',
      ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'],
      { encoding: 'utf8' },
    );
    if (gitPath.status !== 0) return;
    const raw = gitPath.stdout.trim();
    if (!raw) return;
    const absolute = isAbsolute(raw) ? raw : resolve(worktreePath, raw);
    mkdirSync(resolve(absolute, '..'), { recursive: true });
    const existing = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
    if (existing.split('\n').includes(EXCLUDE_ENTRY)) return;
    const separator = existing && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(absolute, `${existing}${separator}${EXCLUDE_ENTRY}\n`);
  } catch {
    // Best-effort git-status hygiene; never block seeding.
  }
}

interface ProvisionState {
  startedAt: number;
  promise: Promise<void>;
}

/** One provisioning run per checkout per process — module-level by design. */
const provisionRuns = new Map<string, ProvisionState>();

const PROVISION_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Pure decision half of {@link ensureCheckoutToolchainProvisioned}, so the
 * expensive commands stay out of unit tests: which installs/builds a checkout
 * still needs. Empty when everything is already present.
 */
export function toolchainProvisionSteps(checkoutRoot: string): ProvisionStep[] {
  const steps: ProvisionStep[] = [];
  if (!existsSync(resolve(checkoutRoot, 'package.json'))) return steps;
  const hasLock = existsSync(resolve(checkoutRoot, 'package-lock.json'));
  if (!existsSync(resolve(checkoutRoot, 'node_modules'))) {
    steps.push({
      label: 'npm ci (root)',
      args: hasLock ? ['ci'] : ['install', '--no-audit', '--no-fund'],
    });
  }
  const mobile = resolve(checkoutRoot, 'apps', 'mobile');
  if (existsSync(resolve(mobile, 'package.json')) && !existsSync(resolve(mobile, 'node_modules'))) {
    const mobileHasLock = existsSync(resolve(mobile, 'package-lock.json'));
    steps.push({
      label: 'npm ci (apps/mobile)',
      cwd: 'apps/mobile',
      args: mobileHasLock ? ['ci'] : ['install', '--no-audit', '--no-fund'],
    });
  }
  // Mobile resolves `@beeline/buzz-client` through the package's built dist/;
  // a fresh checkout has none until these run.
  for (const workspace of ['@beeline/nostr', '@beeline/buzz-client']) {
    const pkgName = workspace.replace('@beeline/', '');
    if (
      existsSync(resolve(checkoutRoot, 'packages', pkgName, 'package.json')) &&
      !existsSync(resolve(checkoutRoot, 'packages', pkgName, 'dist', 'index.js'))
    ) {
      steps.push({ label: `build ${workspace}`, args: ['run', 'build', '-w', workspace] });
    }
  }
  return steps;
}

/**
 * Fire-and-forget: bring the canonical checkout's toolchain up (installs +
 * package builds) once per process. Resolves silently; every failure is logged
 * and swallowed — an unprovisioned checkout must never fail a Room join or a
 * corner open.
 */
export function ensureCheckoutToolchainProvisioned(
  checkoutRoot: string,
  log?: (line: string) => void,
): void {
  const say = log ?? ((line: string) => console.log(`[body] ${line}`));
  const existing = provisionRuns.get(checkoutRoot);
  if (existing) return;
  const steps = toolchainProvisionSteps(checkoutRoot);
  if (!steps.length) return;
  const promise = (async () => {
    for (const step of steps) {
      const cwd = step.cwd ? resolve(checkoutRoot, step.cwd) : checkoutRoot;
      say(`toolchain provisioning ${step.label} in ${checkoutRoot}`);
      const result = spawnSync('npm', step.args, {
        cwd,
        encoding: 'utf8',
        timeout: PROVISION_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      if (result.status !== 0) {
        say(
          `toolchain provisioning failed at ${step.label} (exit ${result.status ?? 'signal'}): ` +
            `${(result.stderr || result.stdout || '').split('\n').at(-2) ?? ''}`.trim(),
        );
        return;
      }
    }
    say(`toolchain provisioning done for ${checkoutRoot}`);
  })();
  provisionRuns.set(checkoutRoot, { startedAt: Date.now(), promise });
  promise.catch(() => undefined);
}
