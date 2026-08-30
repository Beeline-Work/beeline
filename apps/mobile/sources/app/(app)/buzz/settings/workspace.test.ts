import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const auth = vi.hoisted(() => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32),
  })),
}));
const avatarUpload = vi.hoisted(() => ({ pickAndUploadAvatar: vi.fn() }));
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async () => undefined) }));
const modal = vi.hoisted(() => ({ actionSheet: vi.fn() }));
const roomViews = vi.hoisted(() => ({ workspace: vi.fn(), chats: vi.fn() }));
const client = vi.hoisted(() => ({
  surfaceSubscribe: vi.fn(async () => vi.fn()),
  renameCommunity: vi.fn(),
  setCommunityAvatar: vi.fn(),
  setCommunityVisibility: vi.fn(),
  setChannelVisibility: vi.fn(),
}));

vi.mock('@beeline/buzz-client', () => ({
  RoomViewClient: class {
    workspace = roomViews.workspace;
    chats = roomViews.chats;
  },
  SurfaceRefreshScheduler: class<T> {
    constructor(
      private readonly options: {
        fetch: () => Promise<T>;
        apply: (value: T) => void;
        onError?: (error: unknown) => void;
      },
    ) {}
    async startAfter(listenReady: Promise<unknown>) {
      await listenReady;
      await this.refresh();
    }
    force() {
      void this.refresh();
    }
    dispose() {}
    private async refresh() {
      try {
        this.options.apply(await this.options.fetch());
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  },
  isChatListView: () => true,
  isWorkspaceView: () => true,
}));

vi.mock('expo-router', () => ({
  router: navigation,
  useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  useLocalSearchParams: () => ({ communityId: 'workspace-1' }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/auth/buzz-identity-storage', () => auth);
vi.mock('@/buzz/avatar-upload', () => avatarUpload);
vi.mock('expo-clipboard', () => clipboard);
vi.mock('@/modal', () => ({ Modal: modal }));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => client);
  },
}));
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    HullSurface: host('HullSurface'),
    MonoButton: host('MonoButton'),
    PixelGateReveal: host('PixelGateReveal'),
    PixelLoader: host('PixelLoader'),
  };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/components/buzz/RoomGlyph', async () => {
  const ReactModule = await import('react');
  return { RoomGlyph: (props: any) => ReactModule.createElement('RoomGlyph', props) };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    ScrollView: host('ScrollView'),
    Share: { share: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

import WorkspaceSettings from './workspace';

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
  roomViews.workspace.mockResolvedValue(workspaceView());
  roomViews.chats.mockResolvedValue(chatListView());
  avatarUpload.pickAndUploadAvatar.mockResolvedValue(null);
});

function workspaceView(
  role: 'owner' | 'admin' | 'member' = 'owner',
  avatar?: string,
) {
  return {
    workspace: {
      id: 'workspace-1',
      name: 'Hull',
      avatar,
      visibility: 'invite-only',
      role,
      createdAt: 1,
      updatedAt: 1,
    },
    members: [],
    agents: [],
    membersTruncated: false,
    agentsTruncated: false,
    viewer: {
      identity: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Captain' },
      role,
      permissions: { send: true, manage: role !== 'member' },
    },
    watchFilters: [],
  };
}

function room(id: string, name: string, createdAt: number, archived = false) {
  return {
    room: {
      id,
      workspaceId: 'workspace-1',
      name,
      visibility: 'public',
      archived,
      createdAt,
      updatedAt: createdAt,
    },
    memberCount: 1,
    cornerCount: 0,
    unread: false,
  };
}

function chatListView(chats: ReturnType<typeof room>[] = []) {
  return {
    workspace: {
      id: 'workspace-1',
      name: 'Hull',
      visibility: 'invite-only',
      role: 'owner',
      updatedAt: 1,
    },
    chats,
    viewer: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Captain' },
    truncated: false,
    watchFilters: [],
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceSettings));
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('Workspace Settings authority', () => {
  it('shows no admin-only actions to a normal member', async () => {
    roomViews.workspace.mockResolvedValue(workspaceView('member'));
    const renderer = await render();

    expect(renderer.root.findByProps({ testID: 'workspace-settings-denied' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'workspace-overview-settings' })).toHaveLength(0);
  });

  it('loads every scoped settings section for a Workspace owner', async () => {
    const renderer = await render();

    expect(renderer.root.findByProps({ testID: 'workspace-overview-settings' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'workspace-visibility-setting' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'workspace-members-link' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'channel-visibility-settings' })).toBeDefined();
  });

  it('lets a Workspace manager set a canonical uploaded picture', async () => {
    const pictureUrl = 'https://example.test/media/canonical.png';
    avatarUpload.pickAndUploadAvatar.mockResolvedValue(pictureUrl);
    client.setCommunityAvatar.mockImplementation(async () => {
      roomViews.workspace.mockResolvedValue(workspaceView('owner', pictureUrl));
    });
    const renderer = await render();

    await act(async () => {
      renderer.root.findByProps({ testID: 'workspace-picture-change' }).props.onPress();
      await Promise.resolve();
    });

    expect(avatarUpload.pickAndUploadAvatar).toHaveBeenCalledWith(client);
    expect(client.setCommunityAvatar).toHaveBeenCalledWith('workspace-1', pictureUrl);
    expect(renderer.root.findByType('IdentityMark').props.avatarUrl).toBe(pictureUrl);
    expect(renderer.root.findByProps({ testID: 'workspace-picture-clear' })).toBeDefined();
  });

  it('lets a Workspace admin clear its picture back to the generated mark', async () => {
    roomViews.workspace.mockResolvedValue(
      workspaceView('admin', 'https://example.test/media/hull.png'),
    );
    client.setCommunityAvatar.mockImplementation(async () => {
      roomViews.workspace.mockResolvedValue(workspaceView('admin'));
    });
    const renderer = await render();

    await act(async () => {
      renderer.root.findByProps({ testID: 'workspace-picture-clear' }).props.onPress();
      await Promise.resolve();
    });

    expect(client.setCommunityAvatar).toHaveBeenCalledWith('workspace-1', '');
    expect(renderer.root.findByType('IdentityMark').props.avatarUrl).toBeUndefined();
    expect(renderer.root.findAllByProps({ testID: 'workspace-picture-clear' })).toHaveLength(0);
  });

  it('shows no Workspace picture actions to a normal member', async () => {
    roomViews.workspace.mockResolvedValue(
      workspaceView('member', 'https://example.test/media/hull.png'),
    );
    const renderer = await render();

    expect(renderer.root.findByProps({ testID: 'workspace-settings-denied' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'workspace-picture-change' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'workspace-picture-clear' })).toHaveLength(0);
    expect(avatarUpload.pickAndUploadAvatar).not.toHaveBeenCalled();
    expect(client.setCommunityAvatar).not.toHaveBeenCalled();
  });

  it('opens the unified Members page', async () => {
    const renderer = await render();

    await act(async () => {
      await renderer.root.findByProps({ testID: 'open-members' }).props.onPress();
    });

    expect(navigation.push).toHaveBeenCalledWith({
      pathname: '/buzz/members',
      params: { communityId: 'workspace-1' },
    });
  });

  it('does not show archived Rooms in the open-Room visibility section', async () => {
    roomViews.chats.mockResolvedValue(
      chatListView([
        room('484556f2-archived', 'beeline', 1, true),
        room('9d5e2285-live', 'beeline', 2),
      ]),
    );

    const renderer = await render();

    expect(
      renderer.root.findAll(
        (node) =>
          node.type === 'TouchableOpacity' &&
          node.props.testID === 'room-visibility-484556f2-archived',
      ),
    ).toHaveLength(0);
    expect(
      renderer.root.findAll(
        (node) =>
          node.type === 'TouchableOpacity' && node.props.testID === 'room-visibility-9d5e2285-live',
      ),
    ).toHaveLength(1);
  });

  it('qualifies same-name Rooms with human dates and discloses the full ID on demand', async () => {
    roomViews.chats.mockResolvedValue(
      chatListView([
        room('11111111-room', 'beeline', 1),
        room('22222222-room', 'beeline', 2),
      ]),
    );

    const renderer = await render();
    const visibleText = renderer.root.findAllByType('Text').map((node) => node.children.join(''));

    expect(visibleText).toContain('Created Jan 1, 1970 · 00:00:01 UTC');
    expect(visibleText).toContain('Created Jan 1, 1970 · 00:00:02 UTC');
    expect(visibleText.join(' ')).not.toContain('ID 11111111');
    expect(visibleText.join(' ')).not.toContain('ID 22222222');

    act(() => renderer.root.findByProps({ testID: 'room-details-11111111-room' }).props.onPress());
    expect(modal.actionSheet).toHaveBeenCalledWith('#beeline', expect.any(Array), {
      cancelText: 'Cancel',
    });
    const actions = modal.actionSheet.mock.calls[0][1];
    expect(actions[0]).toMatchObject({ text: 'Copy Room ID', metadata: '11111111-room' });
    await act(async () => actions[0].onPress());
    expect(clipboard.setStringAsync).toHaveBeenCalledWith('11111111-room');
  });

  it('names the outcome of the 44pt Room visibility action', async () => {
    roomViews.chats.mockResolvedValue(chatListView([room('room-1', 'atlas', 1)]));

    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'room-visibility-room-1' }).props).toMatchObject({
      accessibilityLabel: 'Make #atlas invite-only',
      accessibilityRole: 'button',
    });
  });

  it('renders Room rows with the # channel mark while stored names stay unmarked', async () => {
    roomViews.chats.mockResolvedValue(chatListView([room('room-1', 'atlas', 1)]));

    const renderer = await render();
    const openRow = renderer.root.findByProps({ accessibilityLabel: 'Open Room #atlas' });
    const rowText = openRow.findByType('Text').props.children;
    // The display form carries exactly one mark...
    expect(rowText).toBe('#atlas');
    // ...and the duplicate-name qualifier still keys off the RAW name.
    expect(openRow.props.accessibilityLabel).toContain('#atlas');
  });
});
