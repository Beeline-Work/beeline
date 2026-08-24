import { MMKV } from 'react-native-mmkv';
import { create } from 'zustand';
import { useBuzzLocalCache } from './local-cache';

/**
 * Durable local tombstones for Rooms this viewer DELETED or LEFT.
 *
 * Why this exists and why it is not a field on the Buzz local cache
 * (`local-cache.ts`): deleting a Room succeeds on the relay, but the Room can
 * keep coming back to the list — an archived Room is deliberately FINISHED deck
 * state, not an invisible one, and in the already-archived case (#396) the
 * leave/remove-member publish is refused by the relay outright, so a refresh's
 * membership read still names this viewer and `loadDisplayChannelBasics`
 * re-materializes the row forever. The reader's own dismissal is LOCAL intent,
 * so it needs LOCAL durable state that survives navigation, refresh, and app
 * restart — exactly like `room-read-state.ts`, and for the same serialization
 * discipline: a tiny synchronous MMKV record written on one user action, never
 * grown into anything a foreground interaction would have to serialize.
 *
 * Keyed per `<viewerPubkey>/<roomId>` because removal is per-viewer intent:
 * another identity on the same device has its own membership and its own list.
 */
const STORAGE_KEY = 'buzz-room-removals-v1';
const MAX_TRACKED_ROOMS = 200;

const storage = new MMKV({ id: 'buzz-room-removals' });

type RemovedRoomsState = {
  /** `<viewerPubkey>/<roomId>` → epoch ms when the viewer removed it. */
  removedAt: Record<string, number>;
  markRoomRemoved: (viewerPubkey: string, roomId: string) => void;
};

function removalKey(viewerPubkey: string, roomId: string): string {
  return `${viewerPubkey}/${roomId}`;
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

/** Keep only the most recent removals so the record cannot grow forever. */
function bounded(removedAt: Record<string, number>): Record<string, number> {
  const entries = Object.entries(removedAt);
  if (entries.length <= MAX_TRACKED_ROOMS) return removedAt;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_TRACKED_ROOMS));
}

export const useRemovedRooms = create<RemovedRoomsState>((set, get) => ({
  removedAt: hydrate(),
  markRoomRemoved: (viewerPubkey, roomId) => {
    const key = removalKey(viewerPubkey, roomId);
    const current = get().removedAt;
    // Stamp strictly-monotonically (a burst of removals inside one wall-clock
    // millisecond must still have distinct recency, or the bound below cannot
    // tell which tombstones are the oldest). Idempotent re-marks only refresh
    // recency, which is what the bound trims on.
    const now = Math.max(Date.now(), ...Object.values(current), 0) + 1;
    const removedAt = bounded({ ...current, [key]: now });
    set({ removedAt });
    storage.set(STORAGE_KEY, JSON.stringify(removedAt));
  },
}));

export function roomRemovalKey(viewerPubkey: string, roomId: string): string {
  return removalKey(viewerPubkey, roomId);
}

export function isRoomRemoved(
  removedAt: Record<string, number>,
  viewerPubkey: string | undefined | null,
  roomId: string,
): boolean {
  if (!viewerPubkey) return false;
  return removedAt[removalKey(viewerPubkey, roomId)] !== undefined;
}

/**
 * The ONE local teardown for a Room this viewer just deleted or left: record
 * the durable tombstone AND purge the cached row/transcript immediately.
 *
 * Called from the delete/leave success path (`chat/[channelId].tsx`'s
 * `handleRoomLifecycle`) BEFORE navigating back to the deck. It runs after the
 * relay operation resolves — which for an already-archived Room (#396) is a
 * deliberate no-op that still resolves — so local removal sticks even when
 * the server-side publish did nothing.
 */
export function markRoomRemovedAndPurge(viewerPubkey: string, roomId: string): void {
  useRemovedRooms.getState().markRoomRemoved(viewerPubkey, roomId);
  useBuzzLocalCache.getState().removeChannel(viewerPubkey, roomId);
}
