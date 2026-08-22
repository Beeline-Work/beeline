import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const auth = vi.hoisted(() => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) })),
}));
const client = vi.hoisted(() => ({
  getCommunity: vi.fn(),
  getChannelMetadata: vi.fn(),
  getChannelRole: vi.fn(),
  communityMembers: vi.fn(),
  listAgents: vi.fn(async () => []),
  listPersonProfiles: vi.fn(async () => []),
  listCommunityInvites: vi.fn(async () => []),
  query: vi.fn(async () => []),
  addMember: vi.fn(async () => undefined),
  waitUntilMemberRole: vi.fn(async () => undefined),
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
vi.mock('@/buzz/avatar-upload', () => ({ pickAndUploadAvatar: vi.fn() }));
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
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.clearAllMocks();
  client.getCommunity.mockResolvedValue({
    communityId: 'workspace-1',
    name: 'Hull',
    visibility: 'invite-only',
    ownerPubkey: 'b'.repeat(64),
  });
  client.query.mockResolvedValue([]);
  client.getChannelMetadata.mockResolvedValue(undefined);
  client.getChannelRole.mockResolvedValue('owner');
});

function roomCreate(id: string, name: string, createdAt: number) {
  return {
    id: `create-${id}`,
    kind: 9007,
    pubkey: 'b'.repeat(64),
    created_at: createdAt,
    content: '',
    sig: 'c'.repeat(128),
    tags: [
      ['h', id],
      ['community', 'workspace-1'],
      ['name', name],
      ['visibility', 'open'],
    ],
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
    client.communityMembers.mockResolvedValue([{ pubkey: 'a'.repeat(64), role: 'member' }]);
    const renderer = await render();

    expect(renderer.root.findByProps({ testID: 'workspace-settings-denied' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'workspace-overview-settings' })).toHaveLength(0);
    expect(client.listCommunityInvites).not.toHaveBeenCalled();
  });

  it('loads every scoped settings section for a Workspace owner', async () => {
    client.communityMembers.mockResolvedValue([{ pubkey: 'a'.repeat(64), role: 'owner' }]);
    const renderer = await render();

    expect(renderer.root.findByProps({ testID: 'workspace-overview-settings' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'workspace-visibility-setting' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'workspace-members-link' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'channel-visibility-settings' })).toBeDefined();
  });

  it('opens the unified Members page', async () => {
    client.communityMembers.mockResolvedValue([{ pubkey: 'a'.repeat(64), role: 'owner' }]);
    const renderer = await render();

    await act(async () => {
      await renderer.root.findByProps({ testID: 'open-members' }).props.onPress();
    });

    expect(navigation.push).toHaveBeenCalledWith({ pathname: '/buzz/members', params: { communityId: 'workspace-1' } });
  });

  it('does not show archived Rooms in the open-Room visibility section', async () => {
    client.communityMembers.mockResolvedValue([{ pubkey: 'a'.repeat(64), role: 'owner' }]);
    client.query.mockResolvedValue([
      roomCreate('484556f2-archived', 'beeline', 1),
      roomCreate('9d5e2285-live', 'beeline', 2),
    ]);
    client.getChannelMetadata.mockImplementation(async (id: string) => ({
      channelId: id,
      name: 'beeline',
      visibility: 'public',
      archived: id.startsWith('484556f2'),
    }));

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
          node.type === 'TouchableOpacity' &&
          node.props.testID === 'room-visibility-9d5e2285-live',
      ),
    ).toHaveLength(1);
  });

  it('renders same-name Rooms with distinct visible identifiers', async () => {
    client.communityMembers.mockResolvedValue([{ pubkey: 'a'.repeat(64), role: 'owner' }]);
    client.query.mockResolvedValue([
      roomCreate('11111111-room', 'beeline', 1),
      roomCreate('22222222-room', 'beeline', 2),
    ]);
    client.getChannelMetadata.mockImplementation(async (id: string) => ({
      channelId: id,
      name: 'beeline',
      visibility: 'public',
      archived: false,
    }));

    const renderer = await render();
    const visibleText = renderer.root.findAllByType('Text').map((node) => node.children.join(''));

    expect(visibleText).toContain('ID 11111111');
    expect(visibleText).toContain('ID 22222222');
  });
});
