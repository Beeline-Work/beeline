import { beforeEach, describe, expect, it, vi } from 'vitest';

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  removeItem: vi.fn<(key: string) => Promise<void>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }));

import {
  clearPersonNameOnboardingPending,
  isPersonNameOnboardingPending,
  markPersonNameOnboardingPending,
  resolveOnboardingPersonName,
} from './person-name';

describe('person name persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asyncStorage.getItem.mockResolvedValue(null);
    asyncStorage.removeItem.mockResolvedValue(undefined);
    asyncStorage.setItem.mockResolvedValue(undefined);
  });

  it('keeps the app root in onboarding while a newly persisted identity is unnamed', async () => {
    await markPersonNameOnboardingPending();
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      '@beeline/person-name/onboarding-pending',
      '1',
    );

    asyncStorage.getItem.mockResolvedValue('1');
    await expect(isPersonNameOnboardingPending()).resolves.toBe(true);

    await clearPersonNameOnboardingPending();
    expect(asyncStorage.removeItem).toHaveBeenCalledWith('@beeline/person-name/onboarding-pending');
  });

  it('prompts a new identity with a stable friendly default', async () => {
    const client = {
      getGlobalPersonProfile: vi.fn().mockResolvedValue(null),
      listCommunities: vi.fn().mockResolvedValue([]),
      getPersonProfile: vi.fn(),
    } as any;

    await expect(resolveOnboardingPersonName(client, 'ab'.repeat(32))).resolves.toMatchObject({
      name: expect.stringMatching(/^\p{Lu}\p{Ll}+$/u),
      communityId: null,
      needsPrompt: true,
    });
  });

  it('does not re-prompt an identity that already published a name', async () => {
    const profile = { name: 'Grace Hopper', avatar: 'https://relay.test/grace.png' };
    const client = {
      getGlobalPersonProfile: vi.fn().mockResolvedValue(profile),
      listCommunities: vi.fn(),
      getPersonProfile: vi.fn(),
    } as any;

    await expect(resolveOnboardingPersonName(client, 'person')).resolves.toMatchObject({
      name: 'Grace Hopper',
      communityId: null,
      profile,
      needsPrompt: false,
    });
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      '@beeline/person-name/preferred/person',
      'Grace Hopper',
    );
  });

  it('keeps a legacy Workspace identity when global migration and local cache writes fail', async () => {
    asyncStorage.setItem.mockRejectedValue(new Error('legacy storage unavailable'));
    const legacy = { name: 'Grace', communityId: 'workspace-old' };
    const client = {
      getGlobalPersonProfile: vi.fn().mockRejectedValue(new Error('global profile unavailable')),
      listCommunities: vi.fn().mockResolvedValue([{ communityId: 'workspace-old' }]),
      getPersonProfile: vi.fn().mockResolvedValue(legacy),
      setGlobalPersonProfile: vi.fn().mockRejectedValue(new Error('migration publish failed')),
    } as any;

    await expect(resolveOnboardingPersonName(client, 'person')).resolves.toEqual({
      name: 'Grace',
      communityId: 'workspace-old',
      profile: legacy,
      needsPrompt: false,
    });
  });

  it('lets the server name replace a stale device copy at onboarding', async () => {
    asyncStorage.getItem.mockResolvedValue('Old Name');
    const profile = { name: 'Server Name' };
    const client = { getGlobalPersonProfile: vi.fn().mockResolvedValue(profile) } as any;

    await expect(resolveOnboardingPersonName(client, 'person')).resolves.toMatchObject({
      name: 'Server Name',
      needsPrompt: false,
    });
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      '@beeline/person-name/preferred/person',
      'Server Name',
    );
  });

  it('falls back to the device hint only while the server cannot answer', async () => {
    asyncStorage.getItem.mockResolvedValue('Hint');
    const client = {
      getGlobalPersonProfile: vi.fn().mockRejectedValue(new Error('offline')),
    } as any;

    await expect(resolveOnboardingPersonName(client, 'person')).resolves.toEqual({
      name: 'Hint',
      communityId: null,
      needsPrompt: false,
    });
    expect(asyncStorage.setItem).not.toHaveBeenCalled();
  });
});
