import { MMKV } from 'react-native-mmkv';
import { create } from 'zustand';
import { useBuzzLocalCache } from './local-cache';

/**
 * Durable local tombstones for CORNERS this viewer CLOSED.
 *
 * Parallel to `removed-rooms.ts` (#402) but for corners, and for the same
 * three reasons. Owner-reported 2026-08-23: closing a corner archived it on
 * the relay only after the daemon's next maintenance tick, and until that
 * landed the corner stayed visible in the room-list dropdown with an open
 * count and stayed enterable as if it were live work. The close is the
 * READER'S OWN dismissal — local intent — so it needs local durable state
 * that survives navigation, refresh, and app restart, and it needs to take
 * effect on the frame the close is confirmed delivered, not a daemon tick
 * later. Relay state remains the lifecycle authority; this tombstone only
 * ever hides work this viewer explicitly dismissed.
 *
 * Keyed per `<viewerPubkey>/<roomId>/<cornerId>` because dismissal is
 * per-viewer intent, same discipline as `removed-rooms.ts`: a tiny
 * synchronous MMKV record written on one user action, never grown into
 * anything a foreground interaction would have to serialize.
 */
const STORAGE_KEY = 'buzz-corner-closures-v1';
const MAX_TRACKED_CORNERS = 400;

const storage = new MMKV({ id: 'buzz-corner-closures' });

type ClosedCornersState = {
  /** `<viewerPubkey>/<roomId>/<cornerId>` → epoch ms when the viewer closed it. */
  closedAt: Record<string, number>;
  markCornerClosed: (viewerPubkey: string, roomId: string, cornerId: string) => void;
};

function closureKey(viewerPubkey: string, roomId: string, cornerId: string): string {
  return `${viewerPubkey}/${roomId}/${cornerId}`;
}

function hydrate(): Record<string, number> {
  try {
    const raw = storage.getString(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      ),
    );
  } catch {
    return {};
  }
}

/** Keep only the most recent closures so the record cannot grow forever. */
function bounded(closedAt: Record<string, number>): Record<string, number> {
  const entries = Object.entries(closedAt);
  if (entries.length <= MAX_TRACKED_CORNERS) return closedAt;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_TRACKED_CORNERS));
}

export const useClosedCorners = create<ClosedCornersState>((set, get) => ({
  closedAt: hydrate(),
  markCornerClosed: (viewerPubkey, roomId, cornerId) => {
    const key = closureKey(viewerPubkey, roomId, cornerId);
    const current = get().closedAt;
    // Stamp strictly-monotonically (same reason as removed-rooms.ts: a burst
    // of closures inside one wall-clock millisecond must still have distinct
    // recency). Idempotent re-marks only refresh recency.
    const now = Math.max(Date.now(), ...Object.values(current), 0) + 1;
    const closedAt = bounded({ ...current, [key]: now });
    set({ closedAt });
    storage.set(STORAGE_KEY, JSON.stringify(closedAt));
  },
}));

export function cornerClosureKey(viewerPubkey: string, roomId: string, cornerId: string): string {
  return closureKey(viewerPubkey, roomId, cornerId);
}

export function isCornerClosed(
  closedAt: Record<string, number>,
  viewerPubkey: string | undefined | null,
  roomId: string,
  cornerId: string,
): boolean {
  if (!viewerPubkey) return false;
  return closedAt[closureKey(viewerPubkey, roomId, cornerId)] !== undefined;
}

/**
 * The ONE local teardown for a corner this viewer just closed: record the
 * durable tombstone AND purge the cached row from every list of this viewer,
 * so the deck's count and dropdown are correct on the next frame instead of
 * whenever the daemon's archive cards land. Called after the close publish
 * resolves (delivery to the relay confirmed); re-closing an already-closed
 * corner is tolerated and re-stamps the tombstone — no-op archive semantics,
 * mirroring #396/#402.
 */
export function markCornerClosedAndPurge(
  viewerPubkey: string,
  roomId: string,
  cornerId: string,
): void {
  useClosedCorners.getState().markCornerClosed(viewerPubkey, roomId, cornerId);
  useBuzzLocalCache.getState().removeCorner(viewerPubkey, roomId, cornerId);
}
