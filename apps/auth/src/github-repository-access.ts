import type { GitHubAppClient } from './github.js';
import type { AuthStore } from './store.js';

export interface GitHubRepositoryAccessDeps {
  app: Pick<GitHubAppClient, 'repositoryByFullName'>;
  store: Pick<
    AuthStore,
    'githubRepositoryAccess' | 'githubRepositoryAlias' | 'saveGitHubRepositoryAlias'
  >;
}

export interface GitHubRepositoryResolution {
  accessible: boolean;
  installationId?: number;
  repositoryId?: number;
  reason?: 'revoked' | 'not_granted';
  /** The repository's current owner/name when it moved and access still holds. */
  resolvedFullName?: string;
  /** Set when the repository moved somewhere the App is NOT granted. */
  movedTo?: string;
}

/**
 * Resolve one Room binding's repository identity to a granted installation.
 *
 * Repository identity on GitHub is the immutable id; owner/name is just its
 * current address. A Room binding written before a transfer or rename keeps
 * the old address, so after an exact miss this follows the trail:
 *
 * 1. exact stored grant (unchanged behaviour),
 * 2. id-heal inside the store (a stale deactivated row carries the old name's id),
 * 3. a persisted alias learned earlier,
 * 4. GitHub's own rename redirect (GET /repos/{old} 301s to the new location),
 *    persisted as an alias on first success.
 *
 * Step 4 also produces the actionable answer for the uncovered case: the new
 * location is known but not granted to the App, which callers must surface
 * instead of a generic not_granted.
 *
 * DEPENDENCY — step 4 only sees a transfer when some installation already
 * covers the destination. GitHub answers GET /repos/{old} with its rename
 * redirect only for viewers that can see the repository at its NEW location,
 * and an App JWT alone reads public repositories; a PRIVATE repo transferred
 * to an account whose install was never recorded yields a bare 404, so
 * `movedTo` stays unknown and step 4 learns nothing. That is why the
 * room-token refusal path reconciles installations BEFORE giving up on an
 * unknown destination: reconcile records the unrecorded install via the App
 * JWT enumeration, and step 2's id-heal then resolves the stale binding onto
 * the transferred repository's immutable id under its new name — no redirect
 * knowledge required.
 */
export async function resolveGitHubRepositoryAccess(
  deps: GitHubRepositoryAccessDeps,
  community: string,
  pubkey: string,
  fullName: string,
  now: Date,
): Promise<GitHubRepositoryResolution> {
  const direct = await deps.store.githubRepositoryAccess(community, pubkey, fullName);
  if (direct.accessible || direct.reason === 'revoked') return direct;

  const alias = await deps.store.githubRepositoryAlias(community, fullName);
  if (alias && alias.toLowerCase() !== fullName.toLowerCase()) {
    const viaAlias = await deps.store.githubRepositoryAccess(community, pubkey, alias);
    if (viaAlias.accessible) return { ...viaAlias, resolvedFullName: alias };
    if (viaAlias.reason === 'revoked') return viaAlias;
  }

  const located = await deps.app.repositoryByFullName(fullName).catch(() => undefined);
  const current = located?.fullName;
  if (!current || current.toLowerCase() === fullName.toLowerCase()) return direct;

  const moved = await deps.store.githubRepositoryAccess(community, pubkey, current);
  if (moved.accessible) {
    await deps.store.saveGitHubRepositoryAlias(community, fullName, current, now);
    return { ...moved, resolvedFullName: current };
  }
  if (moved.reason === 'revoked') return moved;
  return { accessible: false, movedTo: current };
}
