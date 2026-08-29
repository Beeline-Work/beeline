import { describe, expect, it, vi } from 'vitest';
import {
  canRenameRoom,
  canManageRoomRepository,
  canRemoveRoomParticipant,
  confirmRoomRepositoryLink,
  normalizedRoomRole,
  roomLifecycleAction,
} from './room-management';

describe('Room management capabilities', () => {
  it('exposes rename only to owners and admins', () => {
    expect(canRenameRoom('owner')).toBe(true);
    expect(canRenameRoom('admin')).toBe(true);
    expect(canRenameRoom('member')).toBe(false);
    expect(canRenameRoom(null)).toBe(false);
  });

  it('exposes repo set/change only to owners and admins', () => {
    expect(canManageRoomRepository('owner')).toBe(true);
    expect(canManageRoomRepository('admin')).toBe(true);
    expect(canManageRoomRepository('member')).toBe(false);
    expect(canManageRoomRepository(null)).toBe(false);
  });

  it('shows delete only to owners and leave only to normal members', () => {
    expect(roomLifecycleAction('owner')).toBe('delete');
    expect(roomLifecycleAction('admin')).toBeNull();
    expect(roomLifecycleAction('member')).toBe('leave');
    expect(roomLifecycleAction(null)).toBeNull();
  });

  it('never exposes member removal to a non-admin', () => {
    expect(canRemoveRoomParticipant('member', 'member', false)).toBe(false);
    expect(canRemoveRoomParticipant(null, 'member', false)).toBe(false);
  });

  it('keeps owner and peer-admin authority protected', () => {
    expect(canRemoveRoomParticipant('admin', 'owner', false)).toBe(false);
    expect(canRemoveRoomParticipant('admin', 'admin', false)).toBe(false);
    expect(canRemoveRoomParticipant('owner', 'admin', false)).toBe(true);
    expect(canRemoveRoomParticipant('owner', 'member', true)).toBe(false);
  });

  it('normalizes projection roles without granting unknown values authority', () => {
    expect(normalizedRoomRole({ pubkey: 'a', role: 'owner' })).toBe('owner');
    expect(normalizedRoomRole({ pubkey: 'a', role: 'admin' })).toBe('admin');
    expect(normalizedRoomRole({ pubkey: 'a', role: 'unexpected' })).toBe('member');
    expect(normalizedRoomRole(undefined)).toBeNull();
  });

  it('retries none and unverified repository reads until the accepted link appears', async () => {
    const reads = [
      { repositoryResolution: 'none' as const },
      { repositoryResolution: 'unverified' as const },
      {
        repositoryResolution: 'repository' as const,
        repository: {
          key: 'github:2',
          name: 'acme/repo',
          remote: 'git://github.com/acme/repo',
          targetBranch: 'main',
          updatedAt: 20,
          githubEventsEnabled: true,
        },
      },
    ];
    const sleep = vi.fn(async () => undefined);

    await expect(
      confirmRoomRepositoryLink(async () => reads.shift()!, { key: 'github:2', updatedAt: 20 }, {
        attempts: 3,
        sleep,
      }),
    ).resolves.toBe('confirmed');
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('keeps an accepted link pending when confirmation stays unverified or unavailable', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ repositoryResolution: 'unverified' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ repositoryResolution: 'none' });

    await expect(
      confirmRoomRepositoryLink(read, { key: 'github:2', updatedAt: 20 }, {
        attempts: 3,
        sleep: async () => undefined,
      }),
    ).resolves.toBe('pending');
  });

  it('rejects only a different binding at or beyond the accepted write generation', async () => {
    const staleThenCurrent = vi
      .fn()
      .mockResolvedValueOnce({
        repositoryResolution: 'repository',
        repository: { key: 'github:old', updatedAt: 19 },
      })
      .mockResolvedValueOnce({
        repositoryResolution: 'repository',
        repository: { key: 'github:2', updatedAt: 20 },
      });
    await expect(
      confirmRoomRepositoryLink(staleThenCurrent, { key: 'github:2', updatedAt: 20 }, {
        attempts: 2,
        sleep: async () => undefined,
      }),
    ).resolves.toBe('confirmed');

    await expect(
      confirmRoomRepositoryLink(
        async () => ({
          repositoryResolution: 'repository',
          repository: { key: 'github:newer', updatedAt: 21 },
        }),
        { key: 'github:2', updatedAt: 20 },
      ),
    ).resolves.toBe('contradicted');
  });
});
