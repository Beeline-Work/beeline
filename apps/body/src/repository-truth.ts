/**
 * The one answer to "what repository does this Room use, and where is truth?"
 *
 * A remote binding declares the remote as truth and a checkout under
 * `repositoriesRoot` as a disposable cache. A local-only binding explicitly
 * declares its own checkout as truth. The pairing checkout is retained only
 * as private history for the opt-in post-land fast-forward; callers must not
 * use it as an agent cwd, a corner base, a land target, or recap content.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { git, gitAuthed, type GitResult, type Identity } from '@beeline/gate';
import type { RepositoryBinding } from '@beeline/buzz-client';
import {
  inspectLocalRepositoryBounded,
  writeRuntimeRecord,
  type AgentRuntimeRecord,
  type LocalRepositoryBinding,
} from './runtime.js';
import {
  compatibleRepositoryCheckoutPath,
  repositoryCheckoutPaths,
  repositoryDirectoryName,
} from './repository-path.js';

export type RepositoryTruthCheckpoint = 'room-join' | 'corner-open' | 'land' | 'recap';

export interface RemoteRepositoryIdentity {
  /** Current display name, after a provider-side rename. */
  name: string;
  /** Current credential-free canonical remote. */
  remote: string;
  /** Transport URL when it differs from the credential-free display URL. */
  cloneUrl?: string;
}

export interface RepositoryTruth {
  kind: 'remote' | 'local';
  binding: RepositoryBinding;
  checkoutPath: string;
  gitCommonDir: string;
  targetBranch: string;
  remoteName?: string;
  remoteUrl?: string;
  relayRepo?: { ownerHex: string; repo: string };
  /** Room whose current relay binding authorizes remote credentials. */
  roomId?: string;
  /** Pairing history only. Never project this into an agent-visible surface. */
  pairingCheckout?: string;
  /** Stable identity of that historical checkout, before provider refreshes. */
  pairingRepositoryKey?: string;
}

export type PairingCheckoutSyncResult =
  | { status: 'disabled' | 'not-applicable' | 'already-current' }
  | { status: 'fast-forwarded'; from: string; to: string }
  | {
      status: 'refused';
      reason:
        | 'missing'
        | 'not-same-repository'
        | 'dirty'
        | 'wrong-branch'
        | 'local-commits'
        | 'fetch-failed';
    };

export interface RepositoryTruthResolverOptions {
  repositoriesRoot: string;
  relayBaseUrl?: string;
  agent?: Identity;
  syncOperatorCheckout?: boolean;
  /** Provider lookup seam. GitHub App-backed callers use it to follow renames. */
  resolveRemoteIdentity?: (
    binding: RepositoryBinding,
    roomId?: string,
  ) => Promise<RemoteRepositoryIdentity | undefined>;
  /** Credential seam. GitHub App-backed callers inject installation-token git here. */
  runRemoteGit?: (
    cwd: string,
    args: string[],
    binding: RepositoryBinding,
    roomId?: string,
  ) => Promise<GitResult> | GitResult;
}

const REPOSITORY_LOCK_WAIT_MS = 10_000;
const REPOSITORY_LOCK_OWNER_GRACE_MS = 5_000;
const REPOSITORY_LOCK_POLL_MS = 100;
const REPOSITORY_LOCKS_DIRECTORY = '.beeline-locks';

interface RepositoryLockOwner {
  pid: number;
  token: string;
  acquiredAt: number;
}

function repositoryLockOwner(value: string): RepositoryLockOwner | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<RepositoryLockOwner>;
    if (
      !Number.isSafeInteger(parsed.pid) ||
      Number(parsed.pid) <= 0 ||
      typeof parsed.token !== 'string' ||
      !parsed.token ||
      !Number.isFinite(parsed.acquiredAt)
    ) {
      return undefined;
    }
    return parsed as RepositoryLockOwner;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Every Body process shares one canonical checkout store. Git's own lock
 * files protect individual commands, but they do not serialize a multi-step
 * fetch + ref lookup + checkout transaction across agent daemons. Keep that
 * transaction single-writer per repository while allowing unrelated repos to
 * refresh concurrently.
 */
async function withRepositoryCheckoutLock<T>(
  repositoriesRoot: string,
  repositoryKey: string,
  work: () => Promise<T>,
): Promise<T> {
  const locksRoot = resolve(repositoriesRoot, REPOSITORY_LOCKS_DIRECTORY);
  const lock = resolve(locksRoot, `${repositoryDirectoryName(repositoryKey)}.lock`);
  const reclaim = `${lock}.reclaim`;
  const ownerPath = resolve(lock, 'owner.json');
  const token = randomUUID();
  const deadline = Date.now() + REPOSITORY_LOCK_WAIT_MS;
  await mkdir(locksRoot, { recursive: true, mode: 0o700 });

  for (;;) {
    if (
      await stat(reclaim)
        .then(() => true)
        .catch(() => false)
    ) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for canonical repository lock for ${repositoryKey}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, REPOSITORY_LOCK_POLL_MS));
      continue;
    }
    try {
      await mkdir(lock, { mode: 0o700 });
      // A stale-lock reaper may have claimed the old lock immediately after
      // our pre-check. It owns this name until its marker disappears, so do
      // not publish a new owner underneath it.
      if (
        await stat(reclaim)
          .then(() => true)
          .catch(() => false)
      ) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      try {
        await writeFile(
          ownerPath,
          JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }),
          { encoding: 'utf8', mode: 0o600 },
        );
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = repositoryLockOwner(await readFile(ownerPath, 'utf8').catch(() => ''));
      const age =
        Date.now() -
        (await stat(lock)
          .then((value) => value.mtimeMs)
          .catch(() => Date.now()));
      if (
        (owner && !processIsAlive(owner.pid)) ||
        (!owner && age > REPOSITORY_LOCK_OWNER_GRACE_MS)
      ) {
        try {
          await mkdir(reclaim, { mode: 0o700 });
        } catch (reclaimError) {
          if ((reclaimError as NodeJS.ErrnoException).code !== 'EEXIST') throw reclaimError;
          continue;
        }
        try {
          // Re-read after winning the reaper marker. Another waiter may have
          // replaced the stale lock between our first read and this claim;
          // never remove a new live owner's lock.
          const currentOwner = repositoryLockOwner(
            await readFile(ownerPath, 'utf8').catch(() => ''),
          );
          const currentAge =
            Date.now() -
            (await stat(lock)
              .then((value) => value.mtimeMs)
              .catch(() => Date.now()));
          if (
            (currentOwner && !processIsAlive(currentOwner.pid)) ||
            (!currentOwner && currentAge > REPOSITORY_LOCK_OWNER_GRACE_MS)
          ) {
            await rm(lock, { recursive: true, force: true });
          }
        } finally {
          await rm(reclaim, { recursive: true, force: true });
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for canonical repository lock for ${repositoryKey}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, REPOSITORY_LOCK_POLL_MS));
    }
  }

  try {
    return await work();
  } finally {
    const owner = repositoryLockOwner(await readFile(ownerPath, 'utf8').catch(() => ''));
    if (owner?.token === token) await rm(lock, { recursive: true, force: true });
  }
}

/** Best-effort GitHub rename lookup. Authenticated callers may wrap/replace it. */
export async function resolveGitHubRemoteIdentity(
  binding: RepositoryBinding,
): Promise<RemoteRepositoryIdentity | undefined> {
  const match = binding.remote?.match(/^git:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (!match) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}`,
      {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'beeline-body' },
        signal: controller.signal,
      },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as Record<string, unknown>;
    const fullName = typeof body.full_name === 'string' ? body.full_name : '';
    const clone = typeof body.clone_url === 'string' ? body.clone_url : '';
    const parts = fullName.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1] || !clone) return undefined;
    return {
      name: fullName,
      remote: `git://github.com/${parts[0]}/${parts[1]}`,
      cloneUrl: clone,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function cloneUrl(binding: RepositoryBinding): string {
  if (!binding.remote) throw new Error('remote repository has no cloneable URL');
  if (binding.remote.startsWith('git://')) return `https://${binding.remote.slice(6)}.git`;
  return binding.remote;
}

function shortBranch(value: string): string {
  return value.replace(/^refs\/heads\//, '');
}

function relayRepo(binding: RepositoryBinding): { ownerHex: string; repo: string } | undefined {
  const match = binding.remote?.match(/\/git\/([0-9a-fA-F]{64})\/([^/]+?)\/?$/);
  return match
    ? { ownerHex: match[1]!.toLowerCase(), repo: decodeURIComponent(match[2]!) }
    : undefined;
}

function replacePathPrefix(value: string, from: string, to: string): string {
  const absolute = resolve(value);
  return absolute === from || absolute.startsWith(`${from}${sep}`)
    ? `${to}${absolute.slice(from.length)}`
    : value;
}

function worktreePaths(porcelain: string): string[] {
  return porcelain
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => resolve(field.slice('worktree '.length)));
}

/**
 * One-time daemon-start migration for repository keys that were used raw as
 * directory names. The checkout moves and `git worktree repair` rewrites its
 * absolute administrative links. Linked corner directories deliberately stay
 * in place until each corner's next session starts.
 *
 * A collision or rename/repair failure rolls the move back and leaves the old
 * path usable through {@link compatibleRepositoryCheckoutPath}. The function
 * runs before ThinDaemonCore starts any Room or corner session, so no live
 * process has its cwd moved underneath it.
 */
export async function migrateLegacyRepositoryPaths(
  runtime: AgentRuntimeRecord,
  options: { log?: (message: string) => void } = {},
): Promise<{ runtime: AgentRuntimeRecord; migrated: number }> {
  const log = options.log ?? console.warn;
  const repositoriesRoot = resolve(runtime.supervisorRoot, 'beeline', 'repositories');
  let migrated = 0;
  let recordChanged = false;

  const repositoryKeys = new Set(runtime.rooms.map((room) => room.repo.repository.key));
  try {
    for (const entry of await readdir(repositoriesRoot, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        entry.name !== '.beeline-corners' &&
        entry.name !== REPOSITORY_LOCKS_DIRECTORY
      ) {
        repositoryKeys.add(entry.name);
      }
    }
  } catch {
    // A fresh daemon has no repository store yet.
  }

  for (const repositoryKey of repositoryKeys) {
    const paths = repositoryCheckoutPaths(repositoriesRoot, repositoryKey);
    if (!paths.legacy) continue;
    const legacy = paths.legacy;
    const current = paths.current;

    // A previous run may have completed the rename but failed before the
    // runtime record was rewritten. Converge the recorded absolute paths.
    if (!existsSync(legacy) && existsSync(current)) {
      for (const room of runtime.rooms) {
        if (room.repo.repository.key !== repositoryKey) continue;
        const root = replacePathPrefix(room.repo.root, legacy, current);
        const gitCommonDir = replacePathPrefix(room.repo.gitCommonDir, legacy, current);
        if (root !== room.repo.root || gitCommonDir !== room.repo.gitCommonDir) {
          room.repo = { ...room.repo, root, gitCommonDir };
          recordChanged = true;
        }
      }
      continue;
    }
    if (!existsSync(legacy)) continue;

    if (existsSync(current)) {
      log(
        `[body] repository path migration kept legacy ${legacy}: ` +
          'the colon-free destination already exists',
      );
      continue;
    }

    const listed = await git(legacy, ['worktree', 'list', '--porcelain', '-z']);
    if (!listed.ok) {
      log(
        `[body] repository path migration kept legacy ${legacy}: ` +
          `git worktree list failed: ${listed.stderr.trim()}`,
      );
      continue;
    }
    const beforeWorktrees = worktreePaths(listed.stdout);
    let checkoutMoved = false;
    try {
      await rename(legacy, current);
      checkoutMoved = true;
      // Linked corner worktrees stay in place here: another daemon may still
      // own a live session. Git's registry is repaired against their existing
      // paths, and each corner moves immediately before its own next session.
      const repairedWorktrees = beforeWorktrees.map((path) =>
        replacePathPrefix(path, legacy, current),
      );
      const linked = repairedWorktrees.filter((path) => path !== current);
      const repaired = await git(current, ['worktree', 'repair', ...linked]);
      if (!repaired.ok) {
        throw new Error(`git worktree repair failed: ${repaired.stderr.trim()}`);
      }
      for (const path of repairedWorktrees) {
        const verified = await git(path, ['rev-parse', '--show-toplevel']);
        if (!verified.ok || resolve(verified.stdout.trim()) !== path) {
          throw new Error(`migrated worktree did not verify at ${path}`);
        }
      }
    } catch (error) {
      // Put both directories back before repairing the original registrations.
      // If rollback itself cannot complete, fail startup rather than serving a
      // half-migrated repository with broken linked worktrees.
      try {
        if (checkoutMoved) await rename(current, legacy);
        if (checkoutMoved) {
          const rollbackRepair = await git(legacy, [
            'worktree',
            'repair',
            ...beforeWorktrees.filter((path) => path !== legacy),
          ]);
          if (!rollbackRepair.ok) throw new Error(rollbackRepair.stderr.trim());
        }
      } catch (rollbackError) {
        throw new Error(
          `repository path migration failed for ${legacy} and rollback failed: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
          { cause: error },
        );
      }
      log(
        `[body] repository path migration kept legacy ${legacy}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    for (const room of runtime.rooms) {
      if (room.repo.repository.key !== repositoryKey) continue;
      room.repo = {
        ...room.repo,
        root: replacePathPrefix(room.repo.root, legacy, current),
        gitCommonDir: replacePathPrefix(room.repo.gitCommonDir, legacy, current),
      };
    }
    recordChanged = true;
    migrated += 1;
    log(`[body] migrated repository path ${legacy} -> ${current}`);
  }

  if (recordChanged) await writeRuntimeRecord(runtime);
  return { runtime, migrated };
}

export class RepositoryTruthResolver {
  readonly #options: RepositoryTruthResolverOptions;

  constructor(options: RepositoryTruthResolverOptions) {
    this.#options = options;
  }

  checkoutPath(repositoryKey: string): string {
    return compatibleRepositoryCheckoutPath(this.#options.repositoriesRoot, repositoryKey);
  }

  private runRemoteGit(
    cwd: string,
    args: string[],
    binding: RepositoryBinding,
    roomId?: string,
  ): Promise<GitResult> {
    if (this.#options.runRemoteGit) {
      return Promise.resolve(this.#options.runRemoteGit(cwd, args, binding, roomId));
    }
    const relay = relayRepo(binding);
    if (relay && this.#options.agent) {
      return gitAuthed(cwd, this.#options.agent, relay.ownerHex, relay.repo, args);
    }
    if (/^git:\/\/github\.com\//i.test(binding.remote ?? '')) {
      return Promise.resolve({
        ok: false,
        status: 1,
        stdout: '',
        stderr: 'GitHub repository access requires a GitHub App installation token',
      });
    }
    return git(cwd, args);
  }

  /** Resolve and synchronize at every lifecycle checkpoint that can read code. */
  async resolve(
    input: LocalRepositoryBinding,
    checkpoint: RepositoryTruthCheckpoint,
    roomId?: string,
  ): Promise<RepositoryTruth> {
    return withRepositoryCheckoutLock(this.#options.repositoriesRoot, input.repository.key, () =>
      this.resolveUnlocked(input, checkpoint, roomId),
    );
  }

  private async resolveUnlocked(
    input: LocalRepositoryBinding,
    _checkpoint: RepositoryTruthCheckpoint,
    roomId?: string,
  ): Promise<RepositoryTruth> {
    if (input.repository.localOnly || !input.repository.remote) {
      const source = resolve(input.root);
      const root = this.checkoutPath(input.repository.key);
      const targetBranch = shortBranch(input.targetBranch || 'main');
      await mkdir(this.#options.repositoriesRoot, { recursive: true, mode: 0o700 });
      if (source !== root && !existsSync(root)) {
        const cloned = await git(this.#options.repositoriesRoot, [
          'clone',
          '--no-hardlinks',
          source,
          root,
        ]);
        if (!cloned.ok) {
          throw new Error(
            `could not materialize canonical local truth for ${input.repository.name}: ${cloned.stderr}`,
          );
        }
      }
      if (!existsSync(root)) {
        throw new Error(`canonical local truth is missing for ${input.repository.name}`);
      }
      const localBranch = await git(root, ['rev-parse', '--verify', `refs/heads/${targetBranch}`]);
      const remoteBranch = await git(root, [
        'rev-parse',
        '--verify',
        `refs/remotes/origin/${targetBranch}`,
      ]);
      const checkout = localBranch.ok
        ? await git(root, ['checkout', '-q', targetBranch])
        : remoteBranch.ok
          ? await git(root, [
              'checkout',
              '-q',
              '-B',
              targetBranch,
              `refs/remotes/origin/${targetBranch}`,
            ])
          : { ok: false, stderr: `no branch ${targetBranch}` };
      if (!checkout.ok) {
        throw new Error(
          `canonical local truth has no target branch ${targetBranch}: ${checkout.stderr}`,
        );
      }
      if ((await git(root, ['remote', 'get-url', 'origin'])).ok) {
        const removed = await git(root, ['remote', 'remove', 'origin']);
        if (!removed.ok) {
          throw new Error(
            `could not detach canonical local truth from pairing checkout: ${removed.stderr}`,
          );
        }
      }
      const local = await inspectLocalRepositoryBounded(root);
      return {
        kind: 'local',
        binding: input.repository,
        checkoutPath: root,
        gitCommonDir: local.gitCommonDir,
        targetBranch,
        ...(roomId ? { roomId } : {}),
        ...(source !== root
          ? { pairingCheckout: source, pairingRepositoryKey: input.repository.key }
          : {}),
      };
    }

    const original = input.repository;
    const refreshed = await this.#options
      .resolveRemoteIdentity?.(original, roomId)
      .catch(() => undefined);
    const binding: RepositoryBinding = refreshed
      ? { ...original, name: refreshed.name, remote: refreshed.remote, localOnly: false }
      : original;
    const transportUrl = refreshed?.cloneUrl ?? cloneUrl(binding);
    const root = this.checkoutPath(original.key);
    await mkdir(this.#options.repositoriesRoot, { recursive: true, mode: 0o700 });
    if (!existsSync(root)) {
      const cloned = await this.runRemoteGit(
        this.#options.repositoriesRoot,
        ['clone', transportUrl, root],
        binding,
        roomId,
      );
      if (!cloned.ok) {
        throw new Error(`could not clone canonical cache for ${binding.name}: ${cloned.stderr}`);
      }
    }

    const local = await inspectLocalRepositoryBounded(root);
    const remoteName = local.remoteName ?? 'origin';
    // A provider rename may change the transport URL. Keep the cache pointed
    // at the current URL; the Room key deliberately stays stable.
    const currentUrl = await git(root, ['remote', 'get-url', remoteName]);
    if (!currentUrl.ok || currentUrl.stdout.trim() !== transportUrl) {
      const setUrl = await git(root, ['remote', 'set-url', remoteName, transportUrl]);
      if (!setUrl.ok)
        throw new Error(`could not refresh ${binding.name} remote URL: ${setUrl.stderr}`);
    }
    const fetched = await this.runRemoteGit(
      root,
      ['fetch', '--prune', remoteName],
      binding,
      roomId,
    );
    if (!fetched.ok) {
      throw new Error(`could not fetch true tip for ${binding.name}: ${fetched.stderr}`);
    }
    const targetBranch = shortBranch(input.targetBranch || local.targetBranch);
    const remoteRef = `refs/remotes/${remoteName}/${targetBranch}`;
    const tip = await git(root, ['rev-parse', '--verify', `${remoteRef}^{commit}`]);
    if (!tip.ok) throw new Error(`remote ${binding.name} has no target branch ${targetBranch}`);
    const reset = await git(root, ['checkout', '-q', '-B', targetBranch, remoteRef]);
    if (!reset.ok)
      throw new Error(`could not reset canonical cache for ${binding.name}: ${reset.stderr}`);

    return {
      kind: 'remote',
      binding,
      checkoutPath: root,
      gitCommonDir: local.gitCommonDir,
      targetBranch,
      remoteName,
      remoteUrl: binding.remote,
      ...(roomId ? { roomId } : {}),
      ...(input.relayRepo ? { relayRepo: input.relayRepo } : {}),
      ...(resolve(input.root) !== root
        ? { pairingCheckout: resolve(input.root), pairingRepositoryKey: original.key }
        : {}),
    };
  }

  async refresh(
    truth: RepositoryTruth,
    checkpoint: RepositoryTruthCheckpoint,
  ): Promise<RepositoryTruth> {
    const refreshed = await this.resolve(
      {
        root: truth.pairingCheckout ?? truth.checkoutPath,
        gitCommonDir: truth.gitCommonDir,
        ...(truth.remoteName ? { remoteName: truth.remoteName } : {}),
        targetBranch: truth.targetBranch,
        repository: truth.binding,
        ...(truth.relayRepo ? { relayRepo: truth.relayRepo } : {}),
      },
      checkpoint,
      truth.roomId,
    );
    if (truth.pairingCheckout) refreshed.pairingCheckout = truth.pairingCheckout;
    if (truth.pairingRepositoryKey) refreshed.pairingRepositoryKey = truth.pairingRepositoryKey;
    return refreshed;
  }

  /**
   * Opt-in convenience after a successful land. Refuses every shape that
   * could consume captain work: dirt, another branch, or local-only commits.
   */
  async syncPairingCheckout(
    truth: RepositoryTruth,
    landedTip: string,
  ): Promise<PairingCheckoutSyncResult> {
    if (!this.#options.syncOperatorCheckout) return { status: 'disabled' };
    const checkout = truth.pairingCheckout;
    if (!checkout) return { status: 'not-applicable' };
    if (!existsSync(checkout)) return { status: 'refused', reason: 'missing' };
    let local: LocalRepositoryBinding;
    try {
      local = await inspectLocalRepositoryBounded(checkout);
    } catch {
      return { status: 'refused', reason: 'not-same-repository' };
    }
    if (local.repository.key !== (truth.pairingRepositoryKey ?? truth.binding.key)) {
      return { status: 'refused', reason: 'not-same-repository' };
    }
    if ((await git(checkout, ['status', '--porcelain'])).stdout.trim()) {
      return { status: 'refused', reason: 'dirty' };
    }
    const branch = (await git(checkout, ['branch', '--show-current'])).stdout.trim();
    if (branch !== truth.targetBranch) return { status: 'refused', reason: 'wrong-branch' };
    const remoteName = local.remoteName ?? truth.remoteName ?? 'origin';
    const fetched =
      truth.kind === 'remote'
        ? await this.runRemoteGit(
            checkout,
            ['fetch', '--prune', remoteName],
            truth.binding,
            truth.roomId,
          )
        : await git(checkout, [
            'fetch',
            '--no-tags',
            truth.checkoutPath,
            `refs/heads/${truth.targetBranch}`,
          ]);
    if (!fetched.ok) return { status: 'refused', reason: 'fetch-failed' };
    const from = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim();
    if (from === landedTip) return { status: 'already-current' };
    if (!(await git(checkout, ['merge-base', '--is-ancestor', from, landedTip])).ok) {
      return { status: 'refused', reason: 'local-commits' };
    }
    const advanced = await git(checkout, ['merge', '--ff-only', landedTip]);
    if (!advanced.ok) return { status: 'refused', reason: 'local-commits' };
    return { status: 'fast-forwarded', from, to: landedTip };
  }
}
