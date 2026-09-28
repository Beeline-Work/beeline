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
  loadProductTour,
  markTourTipSeen,
  replayProductTour,
  resetProductTourCacheForTests,
  subscribeProductTour,
  tourTipDue,
} from './product-tour';

const ME = 'person-1';

describe('first-sight tip state', () => {
  beforeEach(() => {
    storage.clear();
    resetProductTourCacheForTests();
  });

  it('starts with every tip due, with no overview or offer gate', async () => {
    const state = await loadProductTour(ME);
    expect(state).toEqual({ version: 2, seenTips: [] });
    for (const tip of ['swipe', 'cornerMark', 'squire'] as const)
      expect(tourTipDue(state, tip)).toBe(true);
  });

  it('retires a tip for good and persists it per identity', async () => {
    await markTourTipSeen(ME, 'squire');
    await markTourTipSeen(ME, 'swipe');
    resetProductTourCacheForTests();
    const state = await loadProductTour(ME);
    expect(state).toEqual({ version: 2, seenTips: ['swipe', 'squire'] });
    expect(tourTipDue(state, 'cornerMark')).toBe(true);
    expect((await loadProductTour('someone-else')).seenTips).toEqual([]);
  });

  it('replay brings every tip back and tells listeners', async () => {
    await markTourTipSeen(ME, 'cornerMark');
    const heard: number[] = [];
    const stop = subscribeProductTour(ME, (state) => heard.push(state.seenTips.length));
    expect(await replayProductTour(ME)).toEqual({ version: 2, seenTips: [] });
    stop();
    expect(heard).toEqual([0]);
  });

  it('reads damaged storage as nothing seen and ignores the retired v1 tour', async () => {
    storage.set('@beeline/product-tour/v2/person-1', '{not json');
    expect((await loadProductTour(ME)).seenTips).toEqual([]);
    resetProductTourCacheForTests();
    storage.set(
      '@beeline/product-tour/v2/person-1',
      JSON.stringify({ seenTips: ['rooms', 'squire', 'workbench'] }),
    );
    expect((await loadProductTour(ME)).seenTips).toEqual(['squire']);
  });
});
