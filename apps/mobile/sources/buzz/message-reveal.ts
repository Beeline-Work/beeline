/**
 * Session-scoped registry of transcript messages whose "new arrival" entrance
 * has already played.
 *
 * `isNew` on a `ChatDisplayMessage` is the transient "arrived while you were
 * watching" trigger, but list virtualization can remount a row. This set is
 * the consume-once half: an id animates at most once per app session.
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
