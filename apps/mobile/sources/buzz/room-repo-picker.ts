/**
 * Pure logic for the Room→repo picker (Stage 2 app UI over Stage 1's
 * `packages/buzz-client/src/room-repository.ts`). Kept dependency-free so it
 * is unit-testable with no React Native mocks, matching `corners.ts` /
 * `room-management.ts`.
 */
import type { GitHubInstallationAccess, RoomRepository } from '@beeline/buzz-client';

export type RepoCandidate = {
  key: string;
  name: string;
  remote?: string;
  githubInstallationId?: number;
  defaultBranch?: string;
};

export type GitHubRepositoryLinkagePlan =
  | { kind: 'available'; candidate: RepoCandidate }
  | { kind: 'manage'; installation: GitHubInstallationAccess; fullName: string }
  | { kind: 'install'; owner: string; fullName: string };

/**
 * Decide what GitHub work is actually required for one repository. A caller
 * must execute this plan instead of blindly opening the GitHub App page.
 */
export function githubRepositoryLinkagePlan(
  fullName: string,
  candidates: readonly RepoCandidate[],
  installations: readonly GitHubInstallationAccess[],
): GitHubRepositoryLinkagePlan {
  const normalized = fullName.trim().toLowerCase();
  const candidate = candidates.find((entry) => entry.name.toLowerCase() === normalized);
  if (candidate) return { kind: 'available', candidate };

  const owner = fullName.split('/')[0]?.trim() ?? '';
  const installation = installations.find(
    (entry) =>
      entry.status === 'active' && entry.accountLogin.toLowerCase() === owner.toLowerCase(),
  );
  return installation
    ? { kind: 'manage', installation, fullName }
    : { kind: 'install', owner, fullName };
}

export const GITHUB_REPOSITORY_SELECTION_INSTRUCTION =
  'Choose the repositories Beeline may access, then return.';

/** Distinct repositories exposed by the account's GitHub App installation. */
export function dedupeRepoCandidates(bindings: readonly RepoCandidate[]): RepoCandidate[] {
  const byKey = new Map<string, RepoCandidate>();
  for (const binding of bindings) {
    if (!binding.key || byKey.has(binding.key)) continue;
    byKey.set(binding.key, binding);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The header/settings chip's label, or `null` for a chat-only Room. */
export function roomRepoChipLabel(
  repo: RoomRepository | Pick<RoomRepository, 'binding'> | null,
): string | null {
  return repo?.binding.name.trim() || null;
}

/**
 * Rough client-side heuristic for "the user is about to ask for a corner" —
 * mirrors the daemon's own `isChannelWorkIntent` phrasing
 * (`open/create/launch/start [up] [a/the] [new] corner`) closely enough to
 * catch the common case before the message ever reaches the daemon, so a
 * repo-less Room gets a friendly inline prompt instead of a doomed refusal.
 * Not required to be exhaustive — the daemon's own refusal is still the
 * source of truth for anything this misses.
 */
export function looksLikeCornerOpenIntent(text: string): boolean {
  return /\b(open|create|launch|start(?:\s+up)?)\b[^.!?]{0,40}\bcorner\b/i.test(text);
}

/** Accept a pasted GitHub URL, SSH remote, or owner/repo and return owner/repo. */
export function githubFullNameFromInput(input: string): string | null {
  const value = input.trim();
  const match = value.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:|git:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  );
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
