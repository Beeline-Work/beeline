import { beforeEach, describe, expect, it, vi } from 'vitest';

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  removeItem: vi.fn<(key: string) => Promise<void>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }));

import {
  clearPersonNameOnboardingPending,
  ensurePersonNameForWorkspace,
  isPersonNameOnboardingPending,
  markPersonNameOnboardingPending,
  publishPreferredPersonName,
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

  it('publishes Settings edits without erasing the avatar', async () => {
    const client = {
      getGlobalPersonProfile: vi
        .fn()
        .mockResolvedValue({ avatar: 'https://relay.test/person.png' }),
      getPersonProfile: vi.fn().mockResolvedValue({ avatar: 'https://relay.test/person.png' }),
      setGlobalPersonProfile: vi.fn().mockResolvedValue({ name: 'Ada Lovelace' }),
    } as any;

    await publishPreferredPersonName(client, 'workspace-1', 'person', ' Ada   Lovelace ');

    expect(client.setGlobalPersonProfile).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      handle: 'adalovelace',
      avatar: 'https://relay.test/person.png',
    });
  });

  it('reuses the chosen name when entering another Workspace', async () => {
    asyncStorage.getItem.mockResolvedValue('Ada');
    const client = {
      getGlobalPersonProfile: vi.fn().mockResolvedValue(null),
      getPersonProfile: vi.fn().mockResolvedValue(null),
      setGlobalPersonProfile: vi.fn().mockResolvedValue({ name: 'Ada' }),
    } as any;

    await ensurePersonNameForWorkspace(client, 'workspace-2', 'person');

    expect(client.setGlobalPersonProfile).toHaveBeenCalledWith({
      name: 'Ada',
      handle: 'ada',
      avatar: undefined,
    });
  });

  it('migrates the active legacy Workspace name without losing it', async () => {
    asyncStorage.getItem.mockResolvedValue('Ada');
    const existing = { name: 'Grace', communityId: 'workspace-old' };
    const client = {
      getGlobalPersonProfile: vi.fn().mockResolvedValue(null),
      getPersonProfile: vi.fn().mockResolvedValue(existing),
      setGlobalPersonProfile: vi.fn().mockResolvedValue({ name: 'Grace', handle: 'grace' }),
    } as any;

    await expect(
      ensurePersonNameForWorkspace(client, 'workspace-old', 'person'),
    ).resolves.toMatchObject({ name: 'Grace', handle: 'grace' });
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      '@beeline/person-name/preferred/person',
      'Grace',
    );
    expect(client.setGlobalPersonProfile).toHaveBeenCalledWith({
      name: 'Grace',
      handle: 'grace',
      avatar: undefined,
    });
  });

  it('reads the same global name and picture in every Workspace', async () => {
    const globalProfile = {
      name: 'Ada',
      handle: 'ada',
      avatar: 'https://relay.test/ada.png',
    };
    const client = {
      getGlobalPersonProfile: vi.fn().mockResolvedValue(globalProfile),
      getPersonProfile: vi.fn(),
      setGlobalPersonProfile: vi.fn(),
    } as any;

    await expect(ensurePersonNameForWorkspace(client, 'workspace-1', 'person')).resolves.toBe(
      globalProfile,
    );
    await expect(ensurePersonNameForWorkspace(client, 'workspace-2', 'person')).resolves.toBe(
      globalProfile,
    );

    expect(client.getPersonProfile).not.toHaveBeenCalled();
    expect(client.setGlobalPersonProfile).not.toHaveBeenCalled();
  });
});
