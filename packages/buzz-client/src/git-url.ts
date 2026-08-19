/**
 * Client-side git remote canonicalization for the Room→repo picker's
 * "paste a git URL" path (`apps/mobile`'s repo picker calls
 * `parseGitRemoteInput` to derive a `RoomRepositoryInput` from free text).
 *
 * This deliberately mirrors only the remote-URL branch of
 * `apps/body/src/runtime.ts`'s `canonicalizeOrigin`/`inspectLocalRepository`
 * (https/ssh/scp forms) — not its `file:`/relative-path branches, which need
 * Node's `path` module and never apply to a human-pasted remote URL. The
 * daemon does not recompute a Room's bound `key` on read (it trusts whatever
 * the published `RoomRepository.binding.key` says), so this only needs to be
 * *stable*, not bit-identical to the daemon's own derivation: pasting the
 * same URL twice from the app always yields the same key, which is what lets
 * two Rooms bound to the same repo share one canonical checkout. A repo
 * that's independently paired via `beeline pair --repo` on the daemon AND
 * linked here by URL could in principle derive two different keys for the
 * same underlying repo — a known, noted gap, not a correctness bug (it just
 * costs a second canonical checkout rather than merging into the daemon's).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { RoomRepositoryInput } from './types.js';

/** Normalize common HTTPS/SSH/scp clone forms without retaining credentials. */
export function canonicalizeGitRemote(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('git remote URL is empty');

  const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !value.includes('://')) {
    const path = scp[2]!
      .replace(/^\/+/, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, '');
    return `git://${scp[1]!.toLowerCase()}/${path}`;
  }

  const parsed = new URL(value);
  const path = decodeURIComponent(parsed.pathname)
    .replace(/^\/+/, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '');
  const port = parsed.port ? `:${parsed.port}` : '';
  return `git://${parsed.hostname.toLowerCase()}${port}/${path}`;
}

/** Same derivation as `apps/body/src/runtime.ts`'s `sha256("remote:" + canonical)`. */
export function repositoryKeyForRemote(canonicalRemote: string): string {
  return bytesToHex(sha256(utf8ToBytes(`remote:${canonicalRemote}`)));
}

export function repositoryNameFromCanonicalRemote(remote: string, fallback: string): string {
  const path = remote.slice(remote.lastIndexOf('/') + 1).trim();
  return path || fallback;
}

/**
 * Parse a pasted git URL into a `RoomRepositoryInput`. Returns `null` for
 * empty input or a URL that fails to parse — the caller shows an inline
 * error rather than throwing.
 */
export function parseGitRemoteInput(raw: string): RoomRepositoryInput | null {
  const value = raw.trim();
  if (!value) return null;
  let canonical: string;
  try {
    canonical = canonicalizeGitRemote(value);
  } catch {
    return null;
  }
  return {
    key: repositoryKeyForRemote(canonical),
    name: repositoryNameFromCanonicalRemote(canonical, value),
    remote: canonical,
  };
}
