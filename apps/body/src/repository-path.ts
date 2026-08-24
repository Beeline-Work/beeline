import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MAX_READABLE_SEGMENT_LENGTH = 80;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Turn an external repository identifier into one shell- and PATH-safe path
 * segment without changing the identifier stored on the relay.
 *
 * Safe keys (notably the historical SHA-256 keys) remain byte-for-byte stable.
 * Unsafe keys keep a readable prefix plus a digest so `github:1` cannot collide
 * with either `github-1` or another key that normalizes to the same slug.
 */
function shellSafeDirectoryName(value: string, fallback: string): string {
  if (
    value.length > 0 &&
    value.length <= MAX_READABLE_SEGMENT_LENGTH &&
    value !== '.' &&
    value !== '..' &&
    SAFE_SEGMENT.test(value)
  ) {
    return value;
  }

  const readable = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_READABLE_SEGMENT_LENGTH)
    .replace(/-+$/g, '');
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${readable || fallback}-${digest}`;
}

export function repositoryDirectoryName(repositoryKey: string): string {
  return shellSafeDirectoryName(repositoryKey, 'repository');
}

export function cornerDirectoryName(channelId: string): string {
  return shellSafeDirectoryName(channelId, 'corner');
}

/** The pre-migration path, only when the raw key names one direct child. */
export function legacyRepositoryCheckoutPath(
  repositoriesRoot: string,
  repositoryKey: string,
): string | undefined {
  const root = resolve(repositoriesRoot);
  const legacy = resolve(root, repositoryKey);
  return dirname(legacy) === root ? legacy : undefined;
}

/** New path plus the legacy compatibility candidate used during migration. */
export function repositoryCheckoutPaths(
  repositoriesRoot: string,
  repositoryKey: string,
): { current: string; legacy?: string } {
  const current = resolve(repositoriesRoot, repositoryDirectoryName(repositoryKey));
  const legacy = legacyRepositoryCheckoutPath(repositoriesRoot, repositoryKey);
  return legacy && legacy !== current ? { current, legacy } : { current };
}

/**
 * Resolve a checkout without stranding an in-place legacy clone. New paths are
 * authoritative once migration removes the old directory; until then the old
 * directory wins so a failed/blocked rename remains usable.
 */
export function compatibleRepositoryCheckoutPath(
  repositoriesRoot: string,
  repositoryKey: string,
): string {
  const paths = repositoryCheckoutPaths(repositoriesRoot, repositoryKey);
  return paths.legacy && existsSync(paths.legacy) ? paths.legacy : paths.current;
}

/** True for a generated segment that cannot split POSIX PATH or shell words. */
export function isShellSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    SAFE_SEGMENT.test(value) &&
    !/[:\s]/.test(value)
  );
}
