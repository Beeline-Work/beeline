/**
 * Verdict cache for rooms a given key can provably never be admitted into by
 * self-join: the relay accepted (stored) the kind:9000 member-add, but its
 * kind:39002 member projection never updated — upstream block/buzz honors
 * member-adds only when authored by a room admin. When the predecessor was a
 * room's only admin, NO living key can ever be admitted; re-asserting the
 * full projection wait on every bootstrap would stall app start for the
 * timeout window each launch for a permanently-known answer.
 *
 * Session-scoped within this process and seedable from durable storage by
 * embedders (the mobile app persists these keys across launches). Keyed by
 * (channelId, pubkey): a different key may well be admittable — e.g. by an
 * admin-authored add — so the verdict is never about the room alone.
 */

const verdicts = new Map<string, number>();

export type UnmigratableRoom = { channelId: string; pubkey: string };

export function unmigratableRoomKey(channelId: string, pubkey: string): string {
  return `${channelId}:${pubkey}`;
}

/** Record that this key's self-join can never project into this room. */
export function markRoomUnmigratable(channelId: string, pubkey: string, atMs = Date.now()): void {
  const existing = verdicts.get(unmigratableRoomKey(channelId, pubkey));
  if (existing !== undefined) return;
  verdicts.set(unmigratableRoomKey(channelId, pubkey), atMs);
}

export function isRoomUnmigratable(channelId: string, pubkey: string): boolean {
  return verdicts.has(unmigratableRoomKey(channelId, pubkey));
}

/** Seed from durable storage at process start (idempotent; keeps earliest stamp). */
export function seedUnmigratableRooms(entries: readonly UnmigratableRoom[]): void {
  for (const entry of entries) {
    if (!entry?.channelId || !entry?.pubkey) continue;
    markRoomUnmigratable(entry.channelId, entry.pubkey);
  }
}

/** Current verdicts, for embedders to persist durably. */
export function unmigratableRooms(): UnmigratableRoom[] {
  return [...verdicts.keys()].map((key) => {
    const separator = key.indexOf(':');
    return { channelId: key.slice(0, separator), pubkey: key.slice(separator + 1) };
  });
}

/** Reset the session cache (tests / explicit revalidation). */
export function resetUnmigratableRooms(): void {
  verdicts.clear();
}
