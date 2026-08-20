import { describe, expect, it, vi } from 'vitest';

/**
 * The wall is already ON DEVICE, not only on the relay: a transcript cached by
 * a build that predates this deletion is what paints the first frame of a Room,
 * and nothing rewrites an already-stored row. So hydration is its own floor.
 *
 * The cache is read once at module load, which is why this lives in its own
 * file: the seed has to be in MMKV before `local-cache.ts` is ever imported.
 */
const seeded = vi.hoisted(() => {
  const notice = 'I lost my connection to the relay — reconnecting.';
  const messages = [
    { id: 'human-1', text: 'how is the corner going?', isUser: true, timestamp: 1_000 },
    ...Array.from({ length: 17 }, (_, index) => ({
      id: `wall-${index}`,
      text: notice,
      isUser: false,
      timestamp: 1_100 + index,
    })),
    { id: 'real-1', text: 'The corner is on the rebase now.', isUser: false, timestamp: 1_200 },
  ];
  return {
    notice,
    values: new Map<string, string>([
      [
        'buzz-local-cache-v2',
        JSON.stringify({
          activeViewerPubkey: 'viewer',
          activeListKeyByViewer: {},
          channelLists: {},
          channels: {
            'viewer:room': { lastAccessedAt: 1, messages },
          },
          profiles: {},
        }),
      ],
    ]),
  };
});

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) {
      return seeded.values.get(key);
    }
    set(key: string, value: string) {
      seeded.values.set(key, value);
    }
    delete(key: string) {
      seeded.values.delete(key);
    }
  },
}));

import { channelCacheKey, useBuzzLocalCache } from './local-cache';

describe('a wall already cached on the device', () => {
  it('does not survive hydration', () => {
    const entry = useBuzzLocalCache.getState().channels[channelCacheKey('viewer', 'room')];
    expect(entry).toBeDefined();
    expect(entry?.messages?.map((message) => message.text)).toEqual([
      'how is the corner going?',
      'The corner is on the rebase now.',
    ]);
    expect(entry?.messages?.some((message) => message.text.includes(seeded.notice))).toBe(false);
  });
});
