import { PRODUCT_TOUR_TIPS, type ProductTourTip, type ProductTourView } from '@beeline/api-contract/phone';
import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

/** Server-owned, per-human tour state. A missing state read never opens a tip. */
export const TOUR_TIP_IDS = PRODUCT_TOUR_TIPS;
export type TourTipId = ProductTourTip;
export type ProductTourState = ProductTourView;

export const COMPLETED_TOUR: ProductTourState = { version: 2, seenTips: TOUR_TIP_IDS };
const listeners = new Map<string, Set<(state: ProductTourState) => void>>();

async function operation(name: 'readProductTour' | 'updateProductTour', input: object) {
  const response = await monolithSession.fetch(
    `${getBuzzRuntimeConfig().monolithUrl}/v1/phone/operations/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) throw new Error(`product tour ${name} failed: ${response.status}`);
  const value = (await response.json()) as Partial<ProductTourState>;
  if (value.version !== 2 || !Array.isArray(value.seenTips))
    throw new Error('invalid product tour response');
  return {
    version: 2 as const,
    seenTips: TOUR_TIP_IDS.filter((tip) => value.seenTips!.includes(tip)),
  };
}

export function loadProductTour(_pubkey: string): Promise<ProductTourState> {
  return operation('readProductTour', {});
}

async function write(pubkey: string, tip: TourTipId | 'replay') {
  const state = await operation('updateProductTour', { tip });
  listeners.get(pubkey)?.forEach((listener) => listener(state));
  return state;
}

/** Got it persists before this device hides the tip. */
export function markTourTipSeen(pubkey: string, tip: TourTipId) {
  return write(pubkey, tip);
}

/** Settings → Replay tips. */
export function replayProductTour(pubkey: string) {
  return write(pubkey, 'replay');
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

export function resetProductTourCacheForTests() {
  listeners.clear();
}
