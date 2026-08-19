/**
 * Pure logic for the Room→repo picker (Stage 2 app UI over Stage 1's
 * `packages/buzz-client/src/room-repository.ts`). Kept dependency-free so it
 * is unit-testable with no React Native mocks, matching `corners.ts` /
 * `room-management.ts`.
 */
import type { RoomRepository } from '@beeline/buzz-client';

export type RepoCandidate = {
  key: string;
  name: string;
  remote?: string;
};

/** Distinct repos already bound to some Room in the Workspace — the fallback
 * "connected repos" source per the task brief, since the app has no separate
 * connected-repos list of its own. Keeps the first-seen name for a key. */
export function dedupeRepoCandidates(bindings: readonly RepoCandidate[]): RepoCandidate[] {
  const byKey = new Map<string, RepoCandidate>();
  for (const binding of bindings) {
    if (!binding.key || byKey.has(binding.key)) continue;
    byKey.set(binding.key, binding);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The header/settings chip's label, or `null` for a chat-only Room. */
export function roomRepoChipLabel(repo: RoomRepository | Pick<RoomRepository, 'binding'> | null): string | null {
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
