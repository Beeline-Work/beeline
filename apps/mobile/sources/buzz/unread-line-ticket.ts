/**
 * THE UNREAD LINE IS A ONE-TIME TICKET, not a bookmark.
 *
 * A ticket is issued when the reader is caught up. It is spent the moment a
 * line is drawn for them. Until the next time they reach the newest message,
 * no second line is drawn in that Room — not on re-entry, however much they
 * left unread.
 *
 * The rule this replaces let the line follow the read mark: leave a Room
 * half-read and the next visit drew a line further down, at the row you
 * stopped on. That reads as the same line having moved, and a landmark that
 * moves is not a landmark. A line, once drawn, can only disappear.
 *
 * Ephemeral on purpose. The ledger lives for the life of the app process and
 * is not persisted, so a cold start hands every Room a fresh ticket. Sticky
 * markers are the thing being fixed; a marker that survives a reinstall would
 * be the same complaint with a longer memory.
 */
const spent = new Set<string>();

/** True when this Room's line has already been drawn since the reader was last caught up. */
export function unreadLineSpent(roomId: string): boolean {
  return spent.has(roomId);
}

/** The line has been drawn. No other is owed until the reader reaches the tail. */
export function spendUnreadLine(roomId: string): void {
  spent.add(roomId);
}

/**
 * The reader is caught up, so the next run they fall behind on gets a line.
 * Also how "Mark unread" works: naming a row is asking for the line back.
 */
export function issueUnreadLine(roomId: string): void {
  spent.delete(roomId);
}

/** Tests own the process, so they need a way back to a clean ledger. */
export function resetUnreadLineTickets(): void {
  spent.clear();
}
