import { beforeEach, describe, expect, it, vi } from 'vitest';

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorage,
}));

import {
  loadActiveCommunityId,
  loadLastViewedChannel,
  saveActiveCommunityId,
  saveLastViewedChannel,
} from './community-storage';

describe('community navigation storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asyncStorage.getItem.mockResolvedValue(null);
    asyncStorage.setItem.mockResolvedValue(undefined);
  });

  it('persists standalone and community selections per identity', async () => {
    await saveActiveCommunityId('pubkey-a', null);
    await saveActiveCommunityId('pubkey-b', 'community-b');

    expect(asyncStorage.setItem.mock.calls).toEqual([
      ['@buzzy/community/active/pubkey-a', 'standalone'],
      ['@buzzy/community/active/pubkey-b', 'community-b'],
    ]);

    asyncStorage.getItem.mockResolvedValueOnce('standalone');
    await expect(loadActiveCommunityId('pubkey-a')).resolves.toBeNull();
    asyncStorage.getItem.mockResolvedValueOnce('community-b');
    await expect(loadActiveCommunityId('pubkey-b')).resolves.toBe('community-b');
  });

  it('keeps the last channel independently for each community', async () => {
    await saveLastViewedChannel('pubkey-a', 'community-a', 'channel-a');
    await saveLastViewedChannel('pubkey-a', null, 'channel-home');

    expect(asyncStorage.setItem.mock.calls).toEqual([
      ['@buzzy/community/last-channel/pubkey-a/community-a', 'channel-a'],
      ['@buzzy/community/last-channel/pubkey-a/standalone', 'channel-home'],
    ]);

    asyncStorage.getItem.mockResolvedValue('channel-a');
    await expect(loadLastViewedChannel('pubkey-a', 'community-a')).resolves.toBe('channel-a');
  });
});
