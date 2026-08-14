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
  communityMembers: vi.fn(),
  listAgents: vi.fn(async () => []),
  listPersonProfiles: vi.fn(async () => []),
  listCommunityInvites: vi.fn(async () => []),
  query: vi.fn(async () => []),
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
vi.mock('@/components/buzz/PersonAvatar', async () => {
  const ReactModule = await import('react');
  return { PersonAvatar: (props: any) => ReactModule.createElement('PersonAvatar', props) };
});
vi.mock('@/components/buzz/WorkspaceAvatar', async () => {
  const ReactModule = await import('react');
  return { WorkspaceAvatar: (props: any) => ReactModule.createElement('WorkspaceAvatar', props) };
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

import WorkspaceSettings, { normalizeMemberPubkey } from './workspace';

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
});

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
    expect(renderer.root.findByProps({ testID: 'workspace-members-settings' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'workspace-invites-settings' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'channel-visibility-settings' })).toBeDefined();
  });

  it('accepts hex and npub inputs but rejects arbitrary member text', () => {
    expect(normalizeMemberPubkey('A'.repeat(64))).toBe('a'.repeat(64));
    expect(normalizeMemberPubkey('not-a-key')).toBeNull();
  });
});
