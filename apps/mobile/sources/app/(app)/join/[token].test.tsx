import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'bzi_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const IDENTITY = { publicKey: 'person-1', secretKey: new Uint8Array(32) };

const controls = vi.hoisted(() => ({
  invite: vi.fn(),
  workspaces: vi.fn(),
  redeemInvite: vi.fn(),
  saveActiveCommunityId: vi.fn(),
  createBuzzClient: vi.fn(),
  runtimeConfig: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return { Text: host('Text'), TouchableOpacity: host('TouchableOpacity'), View: host('View') };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: any) => factory({ buzz: new Proxy({}, { get: () => '#000' }) }),
  },
  useUnistyles: () => ({ theme: { buzz: { dim: '#000' } } }),
}));
vi.mock('expo-router', () => ({
  router: { back: vi.fn(), push: vi.fn(), replace: controls.replace },
  useLocalSearchParams: () => ({ token: TOKEN }),
}));
vi.mock('expo-linking', () => ({ useURL: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://server.example'),
  loadBuzzIdentity: vi.fn(async () => IDENTITY),
}));
vi.mock('@/buzz/community-invite', () => ({
  parseCommunityInviteToken: () => TOKEN,
  resolveCommunityInviteRelayUrl: () => 'https://server.example',
}));
vi.mock('@/buzz/community-storage', () => ({
  saveActiveCommunityId: controls.saveActiveCommunityId,
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: controls.runtimeConfig,
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    invite = controls.invite;
    workspaces = controls.workspaces;
  },
}));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: controls.redeemInvite,
}));
vi.mock('@/buzz/room-view-presentation', () => ({ workspaceRailItem: (value: any) => value }));
vi.mock('@/components/buzz/CommunityRail', async () => {
  const ReactModule = await import('react');
  return {
    BuzzCommunityShell: (props: any) =>
      ReactModule.createElement('BuzzCommunityShell', props, props.children),
  };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return { PixelLoader: (props: any) => ReactModule.createElement('PixelLoader', props) };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@beeline/buzz-client', () => ({ createBuzzClient: controls.createBuzzClient }));

import CommunityInviteJoin from './[token]';

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(CommunityInviteJoin));
  });
  return renderer;
}

describe('CommunityInviteJoin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.runtimeConfig.mockReturnValue({ monolithEnabled: false });
    controls.invite.mockResolvedValue({ name: 'Builders' });
    controls.workspaces.mockResolvedValue({ workspaces: [] });
    controls.redeemInvite.mockResolvedValue({ workspaceId: 'workspace-1' });
  });

  it('redeems through the monolith even with a stale false runtime config', async () => {
    const renderer = await render();

    await act(async () => {
      await renderer.root.findByProps({ testID: 'confirm-community-join' }).props.onPress();
    });

    expect(controls.redeemInvite).toHaveBeenCalledWith('redeemInvite', { token: TOKEN });
    expect(controls.saveActiveCommunityId).toHaveBeenCalledWith('person-1', 'workspace-1');
    expect(controls.replace).toHaveBeenCalledWith({
      pathname: '/beeline/channels',
      params: { communityId: 'workspace-1' },
    });
    expect(controls.runtimeConfig).not.toHaveBeenCalled();
    expect(controls.createBuzzClient).not.toHaveBeenCalled();
  });
});
