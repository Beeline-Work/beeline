/**
 * Session-scoped registry of transcript messages whose "new arrival" entrance
 * has already played.
 *
 * `isNew` on a `ChatDisplayMessage` is the transient "arrived while you were
 * watching" trigger, but it is not consumed anywhere: the flag rides along in
 * the in-memory store (and, before the persistence strip in
 * `local-cache.ts`, into MMKV), so every fresh mount of a row — re-entering
 * the Room, the FlatList virtualizer re-materializing a scrolled-off row —
 * replayed the entrance for a message that is not new. This set is the
 * consume-once half: an id animates at most once per app session.
 *
 * Deliberately module-scoped and NEVER persisted: it is the exact opposite of
 * the cached flag — memory of what has been revealed, held only as long as the
 * process lives.
 */
const revealedMessageIds = new Set<string>();

export function hasMessageRevealed(messageId: string): boolean {
  return revealedMessageIds.has(messageId);
}

export function markMessageRevealed(messageId: string): void {
  revealedMessageIds.add(messageId);
}

/** Test seam only. */
export function resetMessageReveals(): void {
  revealedMessageIds.clear();
}
