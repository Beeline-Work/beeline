import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The product tour's per-identity state: four overview cards offered once,
 * then three first-sight spotlights (Room list, a corner, Workbench), each
 * shown once. Device-local and per identity — a per-viewer convenience, like
 * a remembered filter. Replay from Settings resets both layers together and
 * never touches setup data.
 *
 * The tour is offered only to someone who has just arrived through the
 * create-or-join onboarding (`offerProductTour`) or who asked to replay it.
 * An identity with no stored state has never been offered it, so an existing
 * person updating the app is not interrupted by a tour they did not ask for.
 */
export const TOUR_TIP_IDS = ['rooms', 'corner', 'workbench'] as const;
export type TourTipId = (typeof TOUR_TIP_IDS)[number];
export type TourOverviewStatus = 'none' | 'pending' | 'completed' | 'skipped';

export type ProductTourState = {
  readonly version: 1;
  readonly overview: TourOverviewStatus;
  readonly seenTips: readonly TourTipId[];
};

const KEY_PREFIX = '@beeline/product-tour/v1/';
const EMPTY: ProductTourState = { version: 1, overview: 'none', seenTips: [] };
const listeners = new Map<string, Set<(state: ProductTourState) => void>>();
const cache = new Map<string, ProductTourState>();

function key(pubkey: string) {
  return `${KEY_PREFIX}${pubkey}`;
}

function readState(raw: string | null): ProductTourState {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Partial<ProductTourState>;
    const overview: TourOverviewStatus =
      value.overview === 'pending' || value.overview === 'completed' || value.overview === 'skipped'
        ? value.overview
        : 'none';
    const seenTips = Array.isArray(value.seenTips)
      ? TOUR_TIP_IDS.filter((tip) => value.seenTips!.includes(tip))
      : [];
    return { version: 1, overview, seenTips };
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
    // Unreadable storage shows no tour rather than a broken one.
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

async function update(
  pubkey: string,
  change: (current: ProductTourState) => ProductTourState,
): Promise<ProductTourState> {
  return write(pubkey, change(await loadProductTour(pubkey)));
}

/** Arriving through onboarding: offer the overview on the first Room. */
export function offerProductTour(pubkey: string) {
  return update(pubkey, (current) =>
    current.overview === 'none' ? { ...current, overview: 'pending' } : current,
  );
}

export function finishProductTourOverview(pubkey: string, outcome: 'completed' | 'skipped') {
  return update(pubkey, (current) => ({ ...current, overview: outcome }));
}

export function markTourTipSeen(pubkey: string, tip: TourTipId) {
  return update(pubkey, (current) =>
    current.seenTips.includes(tip)
      ? current
      : {
          ...current,
          seenTips: TOUR_TIP_IDS.filter((id) => id === tip || current.seenTips.includes(id)),
        },
  );
}

/** "Skip tips": every remaining spotlight counts as seen. */
export function skipTourTips(pubkey: string) {
  return update(pubkey, (current) => ({ ...current, seenTips: [...TOUR_TIP_IDS] }));
}

/** Settings → Replay product tour: both layers again, one coherent sequence. */
export function replayProductTour(pubkey: string) {
  return write(pubkey, { version: 1, overview: 'pending', seenTips: [] });
}

/** A spotlight shows only once the overview is behind the person. */
export function tourTipDue(state: ProductTourState, tip: TourTipId): boolean {
  return (
    (state.overview === 'completed' || state.overview === 'skipped') &&
    !state.seenTips.includes(tip)
  );
}

/** Position of a tip in the three-step sequence, for its "1 / 3" counter. */
export function tourTipPosition(tip: TourTipId): { index: number; total: number } {
  return { index: TOUR_TIP_IDS.indexOf(tip) + 1, total: TOUR_TIP_IDS.length };
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
