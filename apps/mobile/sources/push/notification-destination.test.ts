import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ workspace: 'workspace-a', save: vi.fn(), room: vi.fn() }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'viewer' }),
  getEffectiveRelayUrl: async () => 'https://relay.test',
}));
vi.mock('@/buzz/community-storage', () => ({
  loadActiveCommunityId: async () => state.workspace,
  saveActiveCommunityId: state.save,
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class { room = state.room; },
  RoomViewHttpError: class extends Error {},
}));

import { resolveBuzzNotificationDestination } from './notification-destination';
const target = { type: 'room-message', target: 'message' as const,
  roomId: 'room-a', channelId: 'room-a', workspaceId: 'workspace-a' };
beforeEach(() => { state.workspace = 'workspace-a'; vi.clearAllMocks(); });

it('keeps an already selected pushed Workspace without notifying its subscribers or reading the Room', async () => {
  expect(await resolveBuzzNotificationDestination(target)).toEqual(target);
  expect(state.save).not.toHaveBeenCalled();
  expect(state.room).not.toHaveBeenCalled();
});

it('persists a different pushed Workspace while preserving the exact destination', async () => {
  state.workspace = 'workspace-b';
  expect(await resolveBuzzNotificationDestination(target)).toEqual(target);
  expect(state.save).toHaveBeenCalledWith('viewer', 'workspace-a');
  expect(state.room).not.toHaveBeenCalled();
});
