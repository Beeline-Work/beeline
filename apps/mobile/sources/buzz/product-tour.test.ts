import { beforeEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({ viewer: 'person-1', seen: new Map<string, string[] | null>() }));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://server.test' }),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: {
    fetch: vi.fn(async (url: string, options: { body: string }) => {
      const { tip } = JSON.parse(options.body) as { tip?: string };
      if (url.endsWith('/updateProductTour')) {
        const seen = server.seen.get(server.viewer);
        if (tip === 'replay') server.seen.set(server.viewer, []);
        else if (seen && tip && !seen.includes(tip)) server.seen.set(server.viewer, [...seen, tip]);
      }
      const seen = server.seen.get(server.viewer);
      return {
        ok: true,
        json: async () => ({ version: 2, seenTips: seen ?? ['swipe', 'cornerMark', 'squire'] }),
      };
    }),
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
describe('server-backed first-sight tip state', () => {
  beforeEach(() => {
    server.viewer = ME;
    server.seen.clear();
    resetProductTourCacheForTests();
  });

  it('treats an existing account without a tour record as completed', async () => {
    server.seen.set(ME, null);
    const state = await loadProductTour(ME);
    for (const tip of ['swipe', 'cornerMark', 'squire'] as const)
      expect(tourTipDue(state, tip)).toBe(false);
    expect((await markTourTipSeen(ME, 'cornerMark')).seenTips).toHaveLength(3);
  });

  it('shows a fresh account, persists Got it, and reloads it on another device', async () => {
    server.seen.set(ME, []);
    expect((await loadProductTour(ME)).seenTips).toEqual([]);
    await markTourTipSeen(ME, 'squire');
    resetProductTourCacheForTests();
    expect((await loadProductTour(ME)).seenTips).toEqual(['squire']);
    server.viewer = 'person-2';
    server.seen.set('person-2', []);
    expect((await loadProductTour('person-2')).seenTips).toEqual([]);
  });

  it('replay re-enrolls only the signed-in person and informs local listeners', async () => {
    server.seen.set(ME, null);
    server.seen.set('person-2', null);
    const heard: number[] = [];
    const stop = subscribeProductTour(ME, (state) => heard.push(state.seenTips.length));
    expect(await replayProductTour(ME)).toEqual({ version: 2, seenTips: [] });
    stop();
    expect(heard).toEqual([0]);
    server.viewer = 'person-2';
    expect((await loadProductTour('person-2')).seenTips).toHaveLength(3);
  });
});
