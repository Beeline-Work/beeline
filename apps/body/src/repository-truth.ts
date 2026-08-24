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
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git, gitAuthed, type GitResult, type Identity } from '@beeline/gate';
import type { RepositoryBinding } from '@beeline/buzz-client';
import { inspectLocalRepositoryBounded, type LocalRepositoryBinding } from './runtime.js';

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

export class RepositoryTruthResolver {
  readonly #options: RepositoryTruthResolverOptions;

  constructor(options: RepositoryTruthResolverOptions) {
    this.#options = options;
  }

  checkoutPath(repositoryKey: string): string {
    return resolve(this.#options.repositoriesRoot, repositoryKey);
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
