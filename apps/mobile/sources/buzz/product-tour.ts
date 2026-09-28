import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The three first-sight tips, per identity: swipe a message into a corner
 * (mobile), press and hold a Room's corner mark, and what Trusty Squire does
 * in Workbench. Each shows once, the first time its target is on screen, in
 * no fixed order; "Got it" retires it for good. Device-local and per
 * identity — a per-viewer convenience, like a remembered filter. Replay from
 * Settings brings all three back and never touches setup data.
 */
export const TOUR_TIP_IDS = ['swipe', 'cornerMark', 'squire'] as const;
export type TourTipId = (typeof TOUR_TIP_IDS)[number];

export type ProductTourState = {
  readonly version: 2;
  readonly seenTips: readonly TourTipId[];
};

// v1 held the retired overview cards and Rooms/corner/Workbench spotlights;
// none of its tips exist any more, so it is left unread.
const KEY_PREFIX = '@beeline/product-tour/v2/';
const EMPTY: ProductTourState = { version: 2, seenTips: [] };
const listeners = new Map<string, Set<(state: ProductTourState) => void>>();
const cache = new Map<string, ProductTourState>();

function key(pubkey: string) {
  return `${KEY_PREFIX}${pubkey}`;
}

function readState(raw: string | null): ProductTourState {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Partial<ProductTourState>;
    const seenTips = Array.isArray(value.seenTips)
      ? TOUR_TIP_IDS.filter((tip) => value.seenTips!.includes(tip))
      : [];
    return { version: 2, seenTips };
  } catch {
    return EMPTY;
  }
}

export async function loadProductTour(pubkey: string): Promise<ProductTourState> {
  const cached = cache.get(pubkey);
  if (cached) return cached;
  let state = EMPTY;
  try {
    state = readState(await AsyncStorage.getItem(key(pubkey)));
  } catch {
    // Unreadable storage shows the tips again rather than a broken state.
  }
  cache.set(pubkey, state);
  return state;
}

async function write(pubkey: string, next: ProductTourState): Promise<ProductTourState> {
  cache.set(pubkey, next);
  listeners.get(pubkey)?.forEach((listener) => listener(next));
  try {
    await AsyncStorage.setItem(key(pubkey), JSON.stringify(next));
  } catch {
    // The in-memory state still holds for this session.
  }
  return next;
}

/** "Got it": this tip never shows again for this person. */
export async function markTourTipSeen(pubkey: string, tip: TourTipId) {
  const current = await loadProductTour(pubkey);
  if (current.seenTips.includes(tip)) return current;
  return write(pubkey, {
    version: 2,
    seenTips: TOUR_TIP_IDS.filter((id) => id === tip || current.seenTips.includes(id)),
  });
}

/** Settings → Replay tips: all three are due again. */
export function replayProductTour(pubkey: string) {
  return write(pubkey, EMPTY);
}

export function tourTipDue(state: ProductTourState, tip: TourTipId): boolean {
  return !state.seenTips.includes(tip);
}

export function subscribeProductTour(
  pubkey: string,
  listener: (state: ProductTourState) => void,
): () => void {
  const set = listeners.get(pubkey) ?? new Set();
  set.add(listener);
  listeners.set(pubkey, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(pubkey);
  };
}

/** Test seam: forget the in-memory cache. */
export function resetProductTourCacheForTests() {
  cache.clear();
  listeners.clear();
}
