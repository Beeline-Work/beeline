import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  active: 'workspace-current' as string | null,
  workspaces: [{ id: 'workspace-current' }, { id: 'workspace-other' }],
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'viewer' }),
  getEffectiveRelayUrl: async () => 'http://localhost',
}));
vi.mock('@/buzz/community-storage', () => ({
  loadActiveCommunityId: async () => state.active,
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspaces() {
      return Promise.resolve({ workspaces: state.workspaces });
    }
  },
}));

import { resolveWalletWorkspaceId } from './wallet-workspace';

describe('Wallet Workspace selection', () => {
  beforeEach(() => {
    state.active = 'workspace-current';
    state.workspaces = [{ id: 'workspace-current' }, { id: 'workspace-other' }];
  });

  it('accepts a route Workspace only while the viewer is a current member', async () => {
    expect(await resolveWalletWorkspaceId('workspace-other')).toBe('workspace-other');
    expect(await resolveWalletWorkspaceId('workspace-stranger')).toBe('workspace-current');
  });

  it('uses the selected Workspace for personal Settings and handles an empty account', async () => {
    expect(await resolveWalletWorkspaceId()).toBe('workspace-current');
    state.workspaces = [];
    expect(await resolveWalletWorkspaceId('workspace-stranger')).toBeNull();
  });
});
