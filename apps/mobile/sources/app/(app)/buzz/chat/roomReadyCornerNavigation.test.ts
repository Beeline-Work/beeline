/**
 * READY-corner navigation through the real BuzzChat presentation path.
 *
 * This deliberately renders the production screen instead of reconstructing
 * its CornerLiveBar props. The fixture controls only hydrateRoomEntry's typed
 * lifecycle answer, then presses the bar the screen itself assembled.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KIND_CHANNEL_MEMBERS,
  createWorkspaceSnapshot,
  reduceWorkspaceEvents,
  selectMembers,
  type CornerMachineState,
} from '@beeline/buzz-client';

const VIEWER = 'a'.repeat(64);
const ROOM = 'charles-room-id';
const CORNER = 'corner-ready-id';
const FIRST_ENTRY_ROSTER = [
  VIEWER,
  'b'.repeat(64),
  'c'.repeat(64),
  'd'.repeat(64),
  'e'.repeat(64),
];
const navigation = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));
const routeParams = vi.hoisted(() => ({ current: { channelId: 'charles-room-id' } }));
const lifecycle = vi.hoisted(() => ({ current: [] as Record<string, unknown>[] }));
const mmkvValues = vi.hoisted(() => new Map<string, string>());

(globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = false;

const hostModule = async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { ReactModule, host };
};

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) {
      return mmkvValues.get(key);
    }
    set(key: string, value: string) {
      mmkvValues.set(key, value);
    }
    delete(key: string) {
      mmkvValues.delete(key);
    }
  },
}));

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => routeParams.current,
  useNavigation: () => ({ getState: () => ({ routes: [] }) }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('react-native-keyboard-controller', async () => {
  const { host } = await hostModule();
  return { KeyboardAvoidingView: host('KeyboardAvoidingView'), useKeyboardState: () => ({}) };
});
vi.mock('react-native-gesture-handler', async () => {
  const { host } = await hostModule();
  return { Swipeable: host('Swipeable') };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (factory: any) => factory({ buzz: {} }) },
  useUnistyles: () => ({ theme: { buzz: {} } }),
}));
vi.mock('react-native', async () => {
  const { ReactModule, host } = await hostModule();
  const FlatList = (props: any) =>
    ReactModule.createElement('FlatList', props, [
      props.ListHeaderComponent ?? null,
      ...(props.data ?? []).map((item: unknown, index: number) =>
        ReactModule.createElement(
          ReactModule.Fragment,
          { key: props.keyExtractor?.(item, index) ?? index },
          props.renderItem?.({ item, index }),
        ),
      ),
      props.ListFooterComponent ?? null,
    ]);
  return {
    Alert: { alert: vi.fn() },
    AppState: {
      currentState: 'active',
      addEventListener: () => ({ remove: vi.fn() }),
    },
    FlatList,
    Image: host('Image'),
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    Linking: { getInitialURL: vi.fn(async () => null), openURL: vi.fn(async () => undefined) },
    Modal: host('Modal'),
    Platform: {
      OS: 'ios',
      select: (values: Record<string, unknown>) => values.ios ?? values.default,
    },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Share: { share: vi.fn(async () => undefined) },
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn(async () => undefined) }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-document-picker', () => ({}));
vi.mock('expo-web-browser', () => ({}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: VIEWER, secretKey: new Uint8Array(32) })),
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
}));
vi.mock('@/auth/github-auth-session', () => ({
  githubInstallationRedirectUri: vi.fn(),
  githubRepositoryRefreshFeedback: vi.fn(),
  resumeInitialGitHubInstallation: vi.fn(async () => null),
  runGitHubInstallationSession: vi.fn(),
}));
vi.mock('@/auth/auth-session', () => ({ authSessionOptions: {} }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/buzz/community-storage', () => ({
  loadActiveCommunityId: vi.fn(async () => 'shared-1'),
  saveActiveCommunityId: vi.fn(async () => undefined),
  saveLastViewedChannel: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/chat-attachment', () => ({
  attachmentOpenUrl: vi.fn(),
  formatAttachmentSize: vi.fn(),
  uploadChatAttachment: vi.fn(),
}));
vi.mock('@/buzz/defer-interaction', () => ({
  afterInteractions: (run: () => void) => {
    run();
    return () => undefined;
  },
}));
vi.mock('@/buzz/local-cache-sync', () => ({
  cacheLiveSessionEvents: vi.fn(() => []),
  drainLiveEventFrame: vi.fn(() => ({ remaining: 0 })),
  loadOlderMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
  revalidateCachedMessages: vi.fn(async () => ({ archiveChannel: false })),
}));
vi.mock('@/buzz/room-entry', () => ({
  hydrateRoomEntry: vi.fn(
    async (_input: unknown, output: Record<string, (...args: any[]) => void>) => {
      output.onCommunities?.([{ communityId: 'shared-1', name: 'Shared' }]);
      output.onViewerIsAgent?.(false);
      output.onChannelRole?.('owner');
      output.onRoomName?.('charles');
      output.onParentChannelId?.(null);
      output.onWorkspaceId?.('shared-1');
      output.onAgents?.([]);
      output.onRoster?.({
        people: [],
        profiles: [],
        canManageWorkspace: true,
        communityId: 'shared-1',
      });
      output.onTranscriptSynced?.({ archiveChannel: false });
      output.onCornerLifecycle?.(lifecycle.current);
    },
  ),
}));

vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => ({}));
    roomRepositoryState = vi.fn(async () => ({ kind: 'none' }));
    agentCommandsRead = vi.fn(async () => null);
    getParentChannelId = vi.fn(async () => null);
    cornerLifecycleSubscribeReady = vi.fn(async () => () => undefined);
  },
}));

vi.mock('@/buzz/nip05-verification', () => ({ useVerifiedNip05Status: () => undefined }));
vi.mock('@/components/buzz/CommunityRail', async () => {
  const { host } = await hostModule();
  return { BuzzCommunityShell: host('BuzzCommunityShell') };
});
vi.mock('@/components/buzz/OwnerGrantNeededCard', async () => {
  const { host } = await hostModule();
  return { OwnerGrantNeededCard: host('OwnerGrantNeededCard'), ownerGrantShareMessage: vi.fn() };
});
vi.mock('@/components/buzz/ChangeReviewPanel', async () => {
  const { host } = await hostModule();
  return { ChangeReviewPanel: host('ChangeReviewPanel') };
});
vi.mock('@/components/buzz/CornerPlanPin', async () => {
  const { host } = await hostModule();
  return { CornerPlanPin: host('CornerPlanPin') };
});
vi.mock('@/components/buzz/RoomContextPreamble', async () => {
  const { host } = await hostModule();
  return { RoomContextPreamble: host('RoomContextPreamble') };
});
vi.mock('@/components/buzz/TurnProgressLine', async () => {
  const { host } = await hostModule();
  return { TurnProgressLine: host('TurnProgressLine') };
});
vi.mock('@/components/buzz/WritePermissionOutcome', async () => {
  const { host } = await hostModule();
  return { WritePermissionOutcome: host('WritePermissionOutcome') };
});
vi.mock('@/components/buzz/ActivityTimeline', async () => {
  const { host } = await hostModule();
  return { ActivityTimeline: host('ActivityTimeline') };
});
vi.mock('@/components/buzz/AttachmentPickerSheet', async () => {
  const { host } = await hostModule();
  return { AttachmentPickerSheet: host('AttachmentPickerSheet') };
});
vi.mock('@/components/buzz/EmptyLedgerState', async () => {
  const { host } = await hostModule();
  return { EmptyLedgerState: host('EmptyLedgerState') };
});
vi.mock('@/components/buzz/HeaderLadder', async () => {
  const { host } = await hostModule();
  return {
    HeaderIdentitySlot: host('HeaderIdentitySlot'),
    HeaderMetaCaps: host('HeaderMetaCaps'),
    HeaderMetaRow: host('HeaderMetaRow'),
  };
});
vi.mock('@/components/buzz/Ledger', async () => {
  const { host } = await hostModule();
  return {
    LEDGER_MARGINALIA_WIDTH: 64,
    LedgerEntry: host('LedgerEntry'),
    LedgerGhostLine: host('LedgerGhostLine'),
    LedgerRoomUpdate: host('LedgerRoomUpdate'),
    LedgerSteer: host('LedgerSteer'),
  };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const { host } = await hostModule();
  return { IdentityMark: host('IdentityMark') };
});
vi.mock('@/components/buzz/RepoPicker', async () => {
  const { host } = await hostModule();
  return { RepoPicker: host('RepoPicker') };
});
vi.mock('@/components/buzz/SlashVerbPicker', async () => {
  const { host } = await hostModule();
  return { SlashVerbPicker: host('SlashVerbPicker') };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const { host } = await hostModule();
  return {
    CornerGlyph: host('CornerGlyph'),
    HullLivePulse: host('HullLivePulse'),
    HullSurface: host('HullSurface'),
    MonoButton: host('MonoButton'),
    NewMessageMaterialize: host('NewMessageMaterialize'),
    PixelLoader: host('PixelLoader'),
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { useBuzzLocalCache } = await import('@/buzz/local-cache');
const { default: BuzzChat } = await import('./[channelId]');

function readyCorner(id: string) {
  const now = Date.now() / 1_000;
  return {
    id,
    name: 'Deliver-Status',
    openerPubkey: 'ox-pubkey',
    machineState: 'waiting' as CornerMachineState,
    machineReason: 'review' as const,
    stateAt: now,
    status: 'open' as const,
    createdAt: now,
    lastActivityAt: now,
  };
}

function firstEntryRosterSnapshot() {
  return reduceWorkspaceEvents(createWorkspaceSnapshot({ workspaceId: 'shared-1' }), [
    {
      type: 'membership',
      eventId: 'first-entry-members',
      channelId: ROOM,
      workspaceId: 'shared-1',
      scope: 'channel',
      authorPubkey: VIEWER,
      createdAt: 1,
      sourceKind: KIND_CHANNEL_MEMBERS,
      signature: 'verified',
      membership: {
        mode: 'snapshot',
        members: FIRST_ENTRY_ROSTER.map((pubkey, index) => ({
          pubkey,
          role: index === 0 ? 'owner' : 'member',
        })),
      },
    } as never,
  ]);
}

async function renderRoom(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(BuzzChat));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree;
}

describe('the Room READY-corner bar navigation', () => {
  beforeEach(() => {
    navigation.push.mockClear();
    navigation.replace.mockClear();
    mmkvValues.clear();
    useBuzzLocalCache.getState().clear();
    useBuzzLocalCache.getState().setActiveViewer(VIEWER);
    useBuzzLocalCache
      .getState()
      .replaceSnapshot(
        VIEWER,
        ROOM,
        createWorkspaceSnapshot({ workspaceId: 'shared-1' }),
        undefined,
      );
    useBuzzLocalCache.getState().patchChannel(VIEWER, ROOM, {
      roomName: 'charles',
      communityId: 'shared-1',
    });
  });

  it('presses the production READY bar into the exact canonical Corner', async () => {
    lifecycle.current = [readyCorner(CORNER)];
    const tree = await renderRoom();
    const bar = tree.root.findByProps({ testID: 'corner-live-bar' });

    expect(bar.props.label).toBe('agent ready for review: #charles/Deliver-Status');
    act(() => bar.props.onPress());

    expect(navigation.push).toHaveBeenCalledWith({
      pathname: '/buzz/chat/[channelId]',
      params: { channelId: CORNER, parent: ROOM },
    });
    act(() => tree.unmount());
  });

  it('does not render a tappable READY affordance for the current Room id', async () => {
    lifecycle.current = [readyCorner(ROOM)];
    const tree = await renderRoom();
    const bars = tree.root.findAllByProps({ testID: 'corner-live-bar' });
    const presentation = bars.find(
      (node) => typeof node.type === 'function' && node.type.name === 'CornerLiveBar',
    );
    const nativeBar = bars.find((node) => typeof node.type === 'string');

    expect(presentation?.props.label).toBe('agent ready for review: #charles/Deliver-Status');
    expect(presentation?.props.onPress).toBeUndefined();
    expect(nativeBar?.type).toBe('View');
    expect(tree.root.findAllByType('Text').map((node) => node.props.children)).not.toContain(
      'view →',
    );
    expect(navigation.push).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('renders all five actual Room members in the roster on first entry', async () => {
    expect(selectMembers(firstEntryRosterSnapshot(), ROOM)).toHaveLength(5);
    useBuzzLocalCache
      .getState()
      .replaceSnapshot(VIEWER, ROOM, firstEntryRosterSnapshot(), undefined);
    const tree = await renderRoom();
    const trigger = tree.root.findByProps({ testID: 'room-participant-roster-trigger' });

    expect(trigger.props.disabled).toBe(false);
    await act(async () => trigger.props.onPress());

    for (const pubkey of FIRST_ENTRY_ROSTER) {
      expect(tree.root.findAllByProps({ testID: `room-roster-person-${pubkey}` }).length).toBeGreaterThan(
        0,
      );
    }
    act(() => tree.unmount());
  });
});
