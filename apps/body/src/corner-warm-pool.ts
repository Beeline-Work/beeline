/**
 * Body-owned warm corner worktrees.
 *
 * Slots are detached linked worktrees kept below the repository's existing
 * corner pool. They retain ignored dependency/build output between creation
 * and assignment. Taking a slot refreshes it to the caller's already-fetched
 * target ref, moves it through Git to the ordinary corner path, and creates
 * the corner feature branch there. Body then owns that path exactly as it owns
 * a cold-created corner: archive/reap destroys it through the normal teardown.
 *
 * This deliberately does not shell out to Treehouse. Treehouse's linked Git
 * layout would work with Body's common-dir bwrap bind, but its CLI owns leases,
 * process termination, reset/return, and an operator-global local-checkout
 * pool. Body also serves relay-backed bare repositories and must remain the
 * sole owner of corner archive/reap. Reusing the pooling idea behind Body's
 * existing path and lifecycle boundary keeps those authorities unambiguous.
 */
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { GitResult } from '@beeline/gate';

export const CORNER_WARM_POOL_DIR = '.warm-pool';
export const DEFAULT_CORNER_WARM_POOL_SIZE = 2;

type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;

export interface CornerWarmPoolOptions {
  repositoryRoot: string;
  cornersRoot: string;
  targetRef: string;
  runGit: GitRunner;
  provision: (worktreePath: string) => Promise<void>;
  size?: number;
  log?: (line: string) => void;
}

export interface TakeWarmCornerOptions extends CornerWarmPoolOptions {
  destination: string;
  featureBranch: string;
}

export function cornerWarmPoolRoot(cornersRoot: string, _targetRef: string): string {
  // One repository pool can serve any Room target: take always hard-resets a
  // slot to the freshly resolved target before it creates the feature branch.
  // Keeping target names out of the path also prevents abandoned pools when a
  // Room changes its landing branch.
  return resolve(cornersRoot, CORNER_WARM_POOL_DIR);
}

function poolSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CORNER_WARM_POOL_SIZE;
  return Math.max(0, Math.min(8, Math.floor(value)));
}

async function targetTip(options: CornerWarmPoolOptions): Promise<string> {
  const result = await options.runGit(options.repositoryRoot, [
    'rev-parse',
    '--verify',
    `${options.targetRef}^{commit}`,
  ]);
  if (!result.ok) throw new Error(`warm-pool target is unavailable: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function withClaim<T>(claimPath: string, action: () => Promise<T>): Promise<T | undefined> {
  let handle;
  try {
    handle = await open(claimPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(claimPath).catch(() => undefined);
  }
}

async function slots(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^slot-\d+$/.test(entry.name) &&
        existsSync(`${resolve(root, entry.name)}.tip`),
    )
    .map((entry) => resolve(root, entry.name))
    .sort();
}

/** Fill missing detached slots. Safe to call repeatedly and concurrently. */
export async function replenishCornerWarmPool(options: CornerWarmPoolOptions): Promise<void> {
  const desired = poolSize(options.size);
  if (desired === 0) return;
  const root = cornerWarmPoolRoot(options.cornersRoot, options.targetRef);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const tip = await targetTip(options);
  for (let index = 1; index <= desired; index += 1) {
    const slot = resolve(root, `slot-${index}`);
    if (existsSync(slot) && existsSync(`${slot}.tip`)) continue;
    const claim = `${slot}.claim`;
    await withClaim(claim, async () => {
      if (existsSync(slot) && existsSync(`${slot}.tip`)) return;
      if (!existsSync(slot)) {
        const added = await options.runGit(options.repositoryRoot, [
          'worktree',
          'add',
          '--detach',
          slot,
          tip,
        ]);
        if (!added.ok) throw new Error(`warm-pool worktree add failed: ${added.stderr.trim()}`);
      } else {
        const reset = await options.runGit(slot, ['reset', '--hard', tip]);
        if (!reset.ok) throw new Error(`warm-pool recovery reset failed: ${reset.stderr.trim()}`);
      }
      try {
        await options.provision(slot);
        await writeFile(`${slot}.tip`, `${tip}\n`, { mode: 0o600 });
        options.log?.(`corner warm pool prepared ${slot} at ${tip.slice(0, 12)}`);
      } catch (error) {
        await options.runGit(options.repositoryRoot, ['worktree', 'remove', '--force', slot]);
        await rm(slot, { recursive: true, force: true });
        throw error;
      }
    });
  }
}

/**
 * Assign one warm slot. `false` means the pool is empty and authorizes the
 * caller's unchanged cold path. Once a slot is claimed, failures throw: a
 * half-moved worktree must not be hidden by retrying a second creation.
 */
export async function takeWarmCornerWorktree(options: TakeWarmCornerOptions): Promise<boolean> {
  if (poolSize(options.size) === 0) return false;
  const root = cornerWarmPoolRoot(options.cornersRoot, options.targetRef);
  const tip = await targetTip(options);
  for (const slot of await slots(root)) {
    const taken = await withClaim(`${slot}.claim`, async () => {
      if (!existsSync(slot)) return false;
      const previousTip = await readFile(`${slot}.tip`, 'utf8')
        .then((value) => value.trim())
        .catch(() => '');
      const reset = await options.runGit(slot, ['reset', '--hard', tip]);
      if (!reset.ok) throw new Error(`warm-pool reset failed: ${reset.stderr.trim()}`);
      const clean = await options.runGit(slot, [
        'clean',
        '-fd',
        '-e',
        'node_modules/',
        '-e',
        'apps/mobile/node_modules/',
      ]);
      if (!clean.ok) throw new Error(`warm-pool clean failed: ${clean.stderr.trim()}`);

      // Built package output is ignored. If the base moved, make provisioning
      // rebuild it rather than handing a corner stale Metro/runtime artifacts.
      if (previousTip && previousTip !== tip) {
        await Promise.all(
          ['nostr', 'buzz-client'].map((pkg) =>
            rm(resolve(slot, 'packages', pkg, 'dist'), { recursive: true, force: true }),
          ),
        );
      }
      // This is a cheap sentinel/dist check for an intact slot, and repairs a
      // crash- or target-refresh-invalidated slot before it is advertised.
      await options.provision(slot);

      await mkdir(resolve(options.destination, '..'), { recursive: true, mode: 0o700 });
      const moved = await options.runGit(options.repositoryRoot, [
        'worktree',
        'move',
        slot,
        options.destination,
      ]);
      if (!moved.ok) throw new Error(`warm-pool worktree move failed: ${moved.stderr.trim()}`);
      const branched = await options.runGit(options.destination, [
        'switch',
        '-c',
        options.featureBranch,
        tip,
      ]);
      if (!branched.ok) {
        // Restore the claimed detached slot when branch creation alone fails.
        // This keeps a retry from finding a half-assigned destination and
        // preserves the expensive provisioned tree for the next valid take.
        const restored = await options.runGit(options.repositoryRoot, [
          'worktree',
          'move',
          options.destination,
          slot,
        ]);
        if (restored.ok) await writeFile(`${slot}.tip`, `${tip}\n`, { mode: 0o600 });
        throw new Error(`warm-pool feature branch failed: ${branched.stderr.trim()}`);
      }
      await unlink(`${slot}.tip`).catch(() => undefined);
      options.log?.(`corner warm pool assigned ${options.destination} at ${tip.slice(0, 12)}`);
      return true;
    });
    if (taken) return true;
  }
  return false;
}
