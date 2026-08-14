import { decodeNpub } from '@beeline/nostr';
import type { AcpPermissionRequest } from './acp.js';

export const NAMED_REPOSITORY_PERMISSION_COMMAND = 'beeline-request-edit-corner';

export interface NamedRepositoryTarget {
  /** Exact owner/repo identity shown to and approved by the human. */
  id: string;
  owner: string;
  repo: string;
  kind: 'github' | 'relay';
  /** Relay authentication and Git endpoints use the decoded hex owner. */
  relayOwnerHex?: string;
}

const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** Parse one explicit, cloneable owner/repo identity without guessing or defaulting. */
export function parseNamedRepositoryTarget(value: string): NamedRepositoryTarget {
  const id = value.trim();
  const parts = id.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('repository target must be exactly owner/repo');
  }
  const [owner, repo] = parts as [string, string];
  if (!REPOSITORY_NAME.test(repo) || repo === '.' || repo === '..' || repo.endsWith('.git')) {
    throw new Error('repository name must be a plain owner/repo name without .git');
  }

  if (/^[0-9a-fA-F]{64}$/.test(owner)) {
    return {
      id,
      owner,
      repo,
      kind: 'relay',
      relayOwnerHex: owner.toLowerCase(),
    };
  }
  if (owner.startsWith('npub1')) {
    let relayOwnerHex: string;
    try {
      relayOwnerHex = decodeNpub(owner);
    } catch {
      throw new Error('repository owner is not a valid relay npub');
    }
    return { id, owner, repo, kind: 'relay', relayOwnerHex };
  }
  if (!GITHUB_OWNER.test(owner)) {
    throw new Error('repository owner must be a GitHub owner, relay hex key, or npub');
  }
  return { id, owner, repo, kind: 'github' };
}

function permissionStrings(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => permissionStrings(item, depth + 1));
  if (typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap((item) =>
    permissionStrings(item, depth + 1),
  );
}

/**
 * A repo-less Room accepts only this explicit native permission marker:
 * `beeline-request-edit-corner --repo owner/repo`.
 *
 * The command is never executed. Body rejects the concrete invocation after
 * projecting the target-bound human allow/deny flow.
 */
export function namedRepositoryTargetFromPermission(
  permission: AcpPermissionRequest,
): NamedRepositoryTarget | undefined {
  const candidates = [
    permission.toolCall?.title,
    ...permissionStrings(permission.toolCall?.rawInput),
  ].filter((value): value is string => typeof value === 'string');
  const marker = new RegExp(
    String.raw`(?:^|\s)${NAMED_REPOSITORY_PERMISSION_COMMAND}\s+--repo(?:=|\s+)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?:\s|$)`,
  );
  for (const candidate of candidates) {
    const match = candidate.match(marker);
    if (!match?.[1]) continue;
    return parseNamedRepositoryTarget(match[1]);
  }
  return undefined;
}

/**
 * Read one exact target from explicit Room prose such as
 * `repository owner/repo` or `--repo owner/repo`. File paths and bare slash
 * tokens are deliberately ignored, so this never guesses a repository.
 */
export function namedRepositoryTargetFromRoomRequest(
  content: string,
): NamedRepositoryTarget | undefined {
  const marker = new RegExp(
    String.raw`(?:^|\s)(?:repository|repo|--repo(?:=|\s+))\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?=[\s,;:!?)]|$)`,
    'i',
  );
  const match = content.normalize('NFKC').match(marker);
  return match?.[1] ? parseNamedRepositoryTarget(match[1]) : undefined;
}
