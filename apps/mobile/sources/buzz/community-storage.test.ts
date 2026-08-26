import { beforeEach, describe, expect, it, vi } from 'vitest';

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
  removeItem: vi.fn<(key: string) => Promise<void>>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorage,
}));

import {
  clearPersonalCommunityId,
  loadActiveCommunityId,
  loadPersonalCommunityId,
  loadLastViewedChannel,
  reconcileStoredWorkspaceSelection,
  saveActiveCommunityId,
  savePersonalCommunityId,
  saveLastViewedChannel,
} from './community-storage';

describe('community navigation storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asyncStorage.getItem.mockResolvedValue(null);
    asyncStorage.setItem.mockResolvedValue(undefined);
    asyncStorage.removeItem.mockResolvedValue(undefined);
  });

  it('persists standalone and community selections per identity', async () => {
    await saveActiveCommunityId('pubkey-a', null);
    await saveActiveCommunityId('pubkey-b', 'community-b');

    expect(asyncStorage.setItem.mock.calls).toEqual([
      ['@beeline/community/active/pubkey-a', 'standalone'],
      ['@beeline/community/active/pubkey-b', 'community-b'],
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
      ['@beeline/community/last-channel/pubkey-a/community-a', 'channel-a'],
      ['@beeline/community/last-channel/pubkey-a/standalone', 'channel-home'],
    ]);

    asyncStorage.getItem.mockResolvedValue('channel-a');
    await expect(loadLastViewedChannel('pubkey-a', 'community-a')).resolves.toBe('channel-a');
  });

  it('remembers the personal Workspace separately from active navigation', async () => {
    await savePersonalCommunityId('pubkey-a', 'personal-a');
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      '@beeline/workspace/personal/pubkey-a',
      'personal-a',
    );

    asyncStorage.getItem.mockResolvedValueOnce('personal-a');
    await expect(loadPersonalCommunityId('pubkey-a')).resolves.toBe('personal-a');

    await clearPersonalCommunityId('pubkey-a');
    expect(asyncStorage.removeItem).toHaveBeenCalledWith('@beeline/workspace/personal/pubkey-a');
  });

  it('persists an authoritative fallback and clears an absent Personal marker', async () => {
    await expect(
      reconcileStoredWorkspaceSelection(
        'pubkey-a',
        [{ communityId: 'tubing-1' }],
        'tubing-1',
        'personal-1',
      ),
    ).resolves.toBeNull();

    expect(asyncStorage.removeItem).toHaveBeenCalledWith('@beeline/workspace/personal/pubkey-a');
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      '@beeline/community/active/pubkey-a',
      'tubing-1',
    );
  });

  it('loads the durable Personal marker when the active deck does not carry it', async () => {
    asyncStorage.getItem.mockResolvedValueOnce('personal-1');

    await expect(
      reconcileStoredWorkspaceSelection(
        'pubkey-a',
        [{ communityId: 'tubing-1' }],
        'tubing-1',
        undefined,
      ),
    ).resolves.toBeNull();

    expect(asyncStorage.getItem).toHaveBeenCalledWith('@beeline/workspace/personal/pubkey-a');
    expect(asyncStorage.removeItem).toHaveBeenCalledWith('@beeline/workspace/personal/pubkey-a');
  });

  it('preserves an absent Personal marker when reconciliation is ambiguous', async () => {
    await expect(
      reconcileStoredWorkspaceSelection(
        'pubkey-a',
        [{ communityId: 'tubing-1' }],
        'tubing-1',
        'personal-1',
        undefined,
        'preserve',
      ),
    ).resolves.toBe('personal-1');

    expect(asyncStorage.removeItem).not.toHaveBeenCalled();
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      '@beeline/community/active/pubkey-a',
      'tubing-1',
    );
  });
});
