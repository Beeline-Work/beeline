import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKSPACE_ID, WELCOME_ROOM_ID } from '@beeline/api-contract/phone';
import {
  routeBuzzNotificationResponse,
  startNotificationResponseEntries,
} from '@/push/notification-response';
import { resetInitialLandingForTests } from '@/navigation/initial-landing';
import { desktopWorkspaceRoute } from '@/buzz/desktop-workbench-state';

const BEELINE_ROOM_ID = 'room-beeline';
const WORKSPACE_ID = 'workspace-mine';
const IDENTITY = { publicKey: 'pk-launch' };

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));
const welcomeStorage = vi.hoisted(() => new Map<string, string>());
const communityStorage = vi.hoisted(() => ({
  loadActiveCommunityId: vi.fn(async () => WORKSPACE_ID),
  saveActiveCommunityId: vi.fn(async () => undefined),
  saveLastViewedChannel: vi.fn(async () => undefined),
  loadLastViewedChannel: vi.fn(async () => BEELINE_ROOM_ID),
}));
const surfaceCache = vi.hoisted(() => ({
  read: vi.fn(async () => null),
  write: vi.fn(async () => undefined),
}));
const chats = vi.hoisted(() =>
  vi.fn(async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Mine', role: 'member' },
    viewer: { pubkey: IDENTITY.publicKey, kind: 'human' },
    chats: [
      {
        room: {
          id: BEELINE_ROOM_ID,
          name: 'beeline',
          workspaceId: WORKSPACE_ID,
          updatedAt: 1,
        },
      },
    ],
  })),
);

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Keyboard: { dismiss: vi.fn() },
    Pressable: host('Pressable'),
    SectionList: host('SectionList'),
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', () => {
  const type = { fontSize: 14, lineHeight: 18, letterSpacing: 0 };
  const hull = new Proxy(
    {
      type: new Proxy({}, { get: () => type }),
      space: new Proxy({}, { get: () => 8 }),
    },
    {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : '#000'),
    },
  );
  return {
    StyleSheet: {
      hairlineWidth: 1,
      create: (factory: any) => (typeof factory === 'function' ? factory({ buzz: hull }) : factory),
    },
  };
});
vi.mock('react-native-gesture-handler', async () => {
  const ReactModule = await import('react');
  return { Swipeable: (props: any) => ReactModule.createElement('Swipeable', props, props.children) };
});
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error', Warning: 'warning' },
}));
vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => ({}),
}));
vi.mock('@react-navigation/native', () => ({
  useFocusEffect: () => undefined,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://server.example'),
  loadBuzzIdentity: vi.fn(async () => IDENTITY),
}));
vi.mock('@/auth/github-auth-session', () => ({
  githubInstallationRedirectUri: () => 'beeline://beeline/github-installation',
}));
vi.mock('@/auth/github-installation-host', () => ({
  useGitHubInstallationSession: () => ({
    handleAddGitHubAccount: vi.fn(),
    handleManageGitHubInstallation: vi.fn(),
  }),
}));
vi.mock('@/buzz/community-storage', () => communityStorage);
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithEnabled: true }),
}));
vi.mock('@/buzz/surface-storage', () => ({
  mobileSurfaceCache: surfaceCache,
  surfaceAddress: () => ({ relayOrigin: 'https://server.example', viewerPubkey: IDENTITY.publicKey, endpoint: '/workspaces' }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => welcomeStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      welcomeStorage.set(key, value);
    },
  },
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspaces = vi.fn(async () => ({
      workspaces: [{ id: WORKSPACE_ID, name: 'Mine' }],
    }));
    chats = chats;
    workspace = vi.fn(async () => ({ members: [], agents: [] }));
  },
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = async () => ({
      surfaceSubscribe: async () => () => undefined,
    });
  },
}));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: vi.fn(),
}));
vi.mock('@/buzz/room-view-presentation', () => ({
  workspaceRailItem: (workspace: { id: string; name: string }) => ({
    communityId: workspace.id,
    name: workspace.name,
  }),
}));
vi.mock('@/buzz/room-list-row', () => ({
  displayGroupedCornerTitle: () => '',
  expandedCornerRefreshAction: () => ({ kind: 'none' }),
  roomRowName: (item: any) => ({ sigil: '#', name: item.room.name }),
  roomRowNeedsAttention: () => false,
  roomRowPreview: () => ({ text: 'No activity' }),
  roomListSections: (items: unknown[]) => [{ kind: 'rooms', title: 'Rooms', data: items }],
  NO_ACTIVITY_PREVIEW: 'No activity',
}));
vi.mock('@/buzz/corner-navigation', () => ({ cornerHref: (id: string) => `/beeline/corners/${id}` }));
vi.mock('@/buzz/corner-display-state', () => ({
  cornerDisplayItems: (corners: unknown[]) => corners.map((item) => ({ item })),
  cornerDisplayState: () => 'working',
}));
vi.mock('@/buzz/relative-time', () => ({ compactRelativeTime: () => '' }));
vi.mock('@/buzz/vocabulary', () => ({
  formatRoomCornerCount: () => '',
  MEMBERS_LABEL: 'Members',
  ROOM_LABEL: 'Room',
  WORKSPACE_LABEL: 'Workspace',
  ROOMS_LABEL: 'Rooms',
}));
vi.mock('@/buzz/room-deck-compose-actions', () => ({ runRoomDeckComposeAction: vi.fn() }));
vi.mock('@/constants/Typography', () => ({
  Typography: {
    default: () => ({}),
    mono: () => ({}),
    ledger: () => ({}),
  },
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn() } }));
vi.mock('@/components/buzz/CommunityRail', async () => {
  const ReactModule = await import('react');
  return {
    BuzzCommunityShell: (props: any) =>
      ReactModule.createElement('BuzzCommunityShell', props, props.children),
    CommunityDrawerTrigger: (props: any) => ReactModule.createElement('CommunityDrawerTrigger', props),
  };
});
vi.mock('@/components/buzz/DirectMessagePickerSheet', async () => {
  const ReactModule = await import('react');
  return { DirectMessagePickerSheet: (props: any) => ReactModule.createElement('DirectMessagePickerSheet', props) };
});
vi.mock('@/components/buzz/ExitGlyph', async () => {
  const ReactModule = await import('react');
  return { ExitGlyph: (props: any) => ReactModule.createElement('ExitGlyph', props) };
});
vi.mock('@/components/buzz/MembersGlyph', async () => {
  const ReactModule = await import('react');
  return { MembersGlyph: (props: any) => ReactModule.createElement('MembersGlyph', props) };
});
vi.mock('@/components/buzz/MemberPickerSheet', async () => {
  const ReactModule = await import('react');
  return { MemberPickerSheet: (props: any) => ReactModule.createElement('MemberPickerSheet', props) };
});
vi.mock('@/components/buzz/RoomListSectionHeader', async () => {
  const ReactModule = await import('react');
  return { RoomListSectionHeader: (props: any) => ReactModule.createElement('RoomListSectionHeader', props) };
});
vi.mock('@/components/buzz/NewRoomDialog', async () => {
  const ReactModule = await import('react');
  return { NewRoomDialog: (props: any) => ReactModule.createElement('NewRoomDialog', props) };
});
vi.mock('@/components/buzz/CornerLiveBar', async () => {
  const ReactModule = await import('react');
  return { CornerWorkingPulse: (props: any) => ReactModule.createElement('CornerWorkingPulse', props) };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    MonoButton: (props: any) => ReactModule.createElement('MonoButton', props),
    PixelLoader: (props: any) => ReactModule.createElement('PixelLoader', props),
  };
});
vi.mock('@/components/buzz/RoomDeckComposeMenu', async () => {
  const ReactModule = await import('react');
  return { RoomDeckComposeMenu: (props: any) => ReactModule.createElement('RoomDeckComposeMenu', props) };
});

import BuzzChannels from './channels';

const deckSource = readFileSync(path.join(__dirname, 'channels.tsx'), 'utf8');
const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.clearAllMocks();
  welcomeStorage.clear();
  communityStorage.loadActiveCommunityId.mockResolvedValue(WORKSPACE_ID);
  resetInitialLandingForTests();
});

async function renderDeck() {
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(React.createElement(BuzzChannels));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

function chatPushes() {
  return navigation.push.mock.calls
    .map((call) => call[0])
    .filter((target) => typeof target === 'string' && target.startsWith('/beeline/chat/'));
}

describe('phone cold launch after the deck replace', () => {
  it('does not restore last-viewed or auto-select the first Room from the deck itself', () => {
    expect(deckSource).not.toContain('loadLastViewedChannel');
    expect(deckSource).not.toContain('desktopWorkspaceRoute');
    expect(
      desktopWorkspaceRoute(WORKSPACE_ID, [BEELINE_ROOM_ID], BEELINE_ROOM_ID).params,
    ).toEqual({ channelId: BEELINE_ROOM_ID, communityId: WORKSPACE_ID });
  });

  it('stays on the deck when a returning identity has a last-viewed #beeline and no notification tap', async () => {
    welcomeStorage.set(`@beeline/welcome/landed/${IDENTITY.publicKey}`, '1');

    await renderDeck();

    expect(chatPushes()).toEqual([]);
    expect(communityStorage.loadLastViewedChannel).not.toHaveBeenCalled();
    expect(communityStorage.saveActiveCommunityId).not.toHaveBeenCalledWith(
      IDENTITY.publicKey,
      DEFAULT_WORKSPACE_ID,
    );
  });

  it('stays on the deck even when the first-launch welcome claim is still open', async () => {
    // Trigger that used to fire: claimFirstLaunchLanding returned a landing and
    // the deck pushed `/beeline/chat/${WELCOME_ROOM_ID}`. Masking condition:
    // `@beeline/welcome/landed/${pubkey}` already set (the returning-user case
    // above). Visible symptom: cold launch opened a Room nobody chose.
    await renderDeck();

    expect(chatPushes()).toEqual([]);
    expect(navigation.push).not.toHaveBeenCalledWith(`/beeline/chat/${WELCOME_ROOM_ID}`);
    expect(navigation.push).not.toHaveBeenCalledWith(`/beeline/chat/${BEELINE_ROOM_ID}`);
  });

  it('does not route a leftover last notification when this launch had no tap', async () => {
    const route = vi.fn().mockResolvedValue(undefined);
    startNotificationResponseEntries({
      addResponseListener: () => ({ remove() {} }),
      getLastResponse: async () => null,
      getAppState: () => 'active',
      route,
    });
    await Promise.resolve();
    expect(route).not.toHaveBeenCalled();

    const { navigate } = {
      navigate: vi.fn(),
    };
    await routeBuzzNotificationResponse(null, {
      router: { navigate },
      handled: new Set(),
      defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
      waitForInitialLanding: async () => 'committed',
      suppressPendingInitialLanding: () => undefined,
      clearLastResponse: async () => undefined,
      resolveTarget: async (target) => target,
      log: () => {},
    });
    expect(navigate).not.toHaveBeenCalled();
  });
});
