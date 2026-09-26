import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void storage.set(key, value)),
    removeItem: vi.fn(async (key: string) => void storage.delete(key)),
  },
}));

import {
  finishProductTourOverview,
  loadProductTour,
  markTourTipSeen,
  offerProductTour,
  replayProductTour,
  resetProductTourCacheForTests,
  skipTourTips,
  subscribeProductTour,
  tourTipDue,
  tourTipPosition,
} from './product-tour';

const ME = 'person-1';

describe('product tour state', () => {
  beforeEach(() => {
    storage.clear();
    resetProductTourCacheForTests();
  });

  it('is never offered to an identity that did not arrive through onboarding', async () => {
    const state = await loadProductTour(ME);
    expect(state.overview).toBe('none');
    expect(tourTipDue(state, 'rooms')).toBe(false);
  });

  it('offers the overview once, then holds each spotlight until it is seen', async () => {
    expect((await offerProductTour(ME)).overview).toBe('pending');
    // While the overview is pending no spotlight competes with it.
    expect(tourTipDue(await loadProductTour(ME), 'rooms')).toBe(false);
    await finishProductTourOverview(ME, 'skipped');
    // Offering again never re-opens a tour the person already answered.
    expect((await offerProductTour(ME)).overview).toBe('skipped');
    let state = await loadProductTour(ME);
    expect(tourTipDue(state, 'rooms')).toBe(true);
    state = await markTourTipSeen(ME, 'rooms');
    expect(tourTipDue(state, 'rooms')).toBe(false);
    expect(tourTipDue(state, 'corner')).toBe(true);
    state = await skipTourTips(ME);
    expect(['rooms', 'corner', 'workbench'].some((tip) => tourTipDue(state, tip as never))).toBe(
      false,
    );
  });

  it('persists per identity across a cold start', async () => {
    await offerProductTour(ME);
    await finishProductTourOverview(ME, 'completed');
    await markTourTipSeen(ME, 'corner');
    resetProductTourCacheForTests();
    expect(await loadProductTour(ME)).toEqual({
      version: 1,
      overview: 'completed',
      seenTips: ['corner'],
    });
    expect((await loadProductTour('someone-else')).overview).toBe('none');
  });

  it('replays both layers from Settings without any other effect', async () => {
    await offerProductTour(ME);
    await finishProductTourOverview(ME, 'skipped');
    await skipTourTips(ME);
    const heard: string[] = [];
    const stop = subscribeProductTour(ME, (state) => heard.push(state.overview));
    expect(await replayProductTour(ME)).toEqual({ version: 1, overview: 'pending', seenTips: [] });
    stop();
    expect(heard).toEqual(['pending']);
  });

  it('reads damaged storage as no tour rather than a broken one', async () => {
    storage.set('@beeline/product-tour/v1/person-1', '{not json');
    expect((await loadProductTour(ME)).overview).toBe('none');
    resetProductTourCacheForTests();
    storage.set(
      '@beeline/product-tour/v1/person-1',
      JSON.stringify({ overview: 'weird', seenTips: ['rooms', 'nope'] }),
    );
    expect(await loadProductTour(ME)).toEqual({
      version: 1,
      overview: 'none',
      seenTips: ['rooms'],
    });
  });

  it('numbers the three spotlights in sequence', () => {
    expect(tourTipPosition('rooms')).toEqual({ index: 1, total: 3 });
    expect(tourTipPosition('workbench')).toEqual({ index: 3, total: 3 });
  });
});
