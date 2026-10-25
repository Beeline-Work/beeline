vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  operation: vi.fn(),
  navigate: vi.fn(),
  beforeRemove: undefined as undefined | ((event: any) => void),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  ScrollView: 'ScrollView',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({}), hairlineWidth: 1 } }));
vi.mock('expo-router', () => ({
  router: { back: vi.fn() },
  useLocalSearchParams: () => ({}),
  useNavigation: () => ({
    addListener: (_: string, callback: any) => {
      state.beforeRemove = callback;
      return () => {};
    },
  }),
}));
vi.mock('@/buzz/latency-route-hook', () => ({ useLatencyRouteFrame: () => {} }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'viewer' }),
  getEffectiveRelayUrl: async () => 'https://server.example',
}));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: state.operation }));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspaceMembers() {
      return Promise.resolve({
        viewer: { identity: { pubkey: 'viewer' }, role: 'member', permissions: { manage: false } },
        grants: [],
        agentsTruncated: false,
      });
    }
  },
}));
vi.mock('@/buzz/corner-navigation', () => ({ navigateToRoom: state.navigate }));
vi.mock('@/buzz/workspace-records', () => ({
  useWorkspaceRecords: () => {},
  workspaceRecord: () => ({ identity: { pubkey: 'person', name: 'Person' }, role: 'member' }),
  workspaceOwnedAgents: () => [],
  workspaceRecordScope: () => 'scope',
  recordWorkspacePage: vi.fn(),
  recordWorkspaceRemoval: vi.fn(),
  recordWorkspaceRole: vi.fn(),
}));
vi.mock('@/buzz/workspace-watch', () => ({
  watchWorkspace: () => ({ release: vi.fn(), ready: Promise.resolve(), rooms: vi.fn() }),
}));
vi.mock('@/buzz/surface-storage', () => ({
  surfaceAddress: () => ({}),
  mobileSurfaceCache: {
    fetch: async (_a: any, _v: any, load: any) => load(),
    subscribe: () => () => {},
    peek: () => null,
    read: async () => null,
  },
}));
vi.mock('@/modal/ModalManager', () => ({ Modal: { confirm: async () => true } }));
vi.mock('@/components/buzz/ProfileIdentity', () => ({
  ProfileIdentity: (props: any) => React.createElement('Identity', {}, props.actions),
}));
vi.mock('@/components/buzz/ProfileActions', () => ({
  ProfileActions: (props: any) => React.createElement('Actions', props),
}));
vi.mock('@/components/buzz/PageHeader', () => ({
  PageHeader: (props: any) => React.createElement('Header', props),
}));
vi.mock('@/components/buzz/RoomListSectionHeader', () => ({ RoomListSectionHeader: () => null }));
vi.mock('@/components/buzz/SettingsRow', () => ({ SettingsRow: () => null }));
vi.mock('@/components/buzz/Button', () => ({ Button: () => null }));
vi.mock('@/components/buzz/MemberGrantRow', () => ({ MemberGrantRow: () => null }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: () => null }));
import { HumanProfile } from './human-profile';

describe('Reproduction R1: Profile back while Message waits', () => {
  it.each(['header back', 'system back'])(
    '%s leaves immediately and a late DM cannot navigate',
    async (method) => {
      let resolve!: (value: unknown) => void;
      state.operation.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      state.navigate.mockClear();
      state.beforeRemove = undefined;
      const onClose = vi.fn();
      let tree: any;
      await act(async () => {
        tree = create(<HumanProfile workspaceId="w" memberId="person" onClose={onClose} />);
      });
      await act(async () => {
        tree.root
          .findByType('Actions')
          .props.actions.find((action: any) => action.testID === 'human-profile-message')
          .onPress();
      });
      const prevented = vi.fn();
      await act(async () => {
        if (method === 'header back') tree.root.findByType('Header').props.onBack();
        else {
          state.beforeRemove?.({ preventDefault: prevented });
          if (!prevented.mock.calls.length) onClose();
        }
      });
      expect(prevented).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledOnce();
      const loading = tree.root.findByType('Actions').props.actions[0].loading;
      await act(async () => tree.unmount());
      await act(async () => resolve({ id: 'dm' }));
      expect(state.navigate).not.toHaveBeenCalled();
      expect(loading).toBe(true);
    },
  );
});
