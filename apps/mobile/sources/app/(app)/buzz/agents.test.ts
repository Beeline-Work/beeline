import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const client = vi.hoisted(() => ({
  listAgents: vi.fn(async () => []),
  communityMembers: vi.fn(),
  getPersonProfile: vi.fn(async () => undefined),
  listPersonProfiles: vi.fn(async () => []),
}));

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => ({ communityId: 'workspace-1' }),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('react-native-keyboard-controller', async () => {
  const ReactModule = await import('react');
  return { KeyboardAwareScrollView: (props: any) => ReactModule.createElement('ScrollView', props, props.children) };
});
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) })),
}));
vi.mock('@/buzz/avatar-upload', () => ({ pickAndUploadAvatar: vi.fn() }));
vi.mock('@/buzz/workspace-bootstrap', () => ({
  prepareWorkspaceContext: vi.fn(async () => ({
    workspaces: [{ communityId: 'workspace-1', name: 'Night Shift', viewerRole: 'owner' }],
    activeWorkspaceId: 'workspace-1',
  })),
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => client);
  },
}));
vi.mock('@/components/buzz/CommunityRail', async () => {
  const ReactModule = await import('react');
  return { BuzzCommunityShell: (props: any) => ReactModule.createElement('BuzzCommunityShell', props, props.children) };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return { HullSurface: host('HullSurface'), HullWaveSignal: host('HullWaveSignal'), MonoButton: host('MonoButton'), PixelLoader: host('PixelLoader') };
});
vi.mock('@/components/buzz/AgentAvatar', async () => {
  const ReactModule = await import('react');
  return { AgentAvatar: (props: any) => ReactModule.createElement('AgentAvatar', props) };
});
vi.mock('@/components/buzz/PersonAvatar', async () => {
  const ReactModule = await import('react');
  return { PersonAvatar: (props: any) => ReactModule.createElement('PersonAvatar', props) };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    Share: { share: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'), TextInput: host('TextInput'), TouchableOpacity: host('TouchableOpacity'), View: host('View'),
  };
});

import MembersScreen from './MembersScreen';

const originalConsoleError = console.error;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.clearAllMocks();
  client.communityMembers.mockResolvedValue([{ pubkey: 'a'.repeat(64), role: 'owner' }]);
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(MembersScreen));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('Members screen', () => {
  it('combines people and agents with distinct admin actions', async () => {
    const renderer = await render();

    expect(renderer.root.findByProps({ testID: 'members-people-section' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'members-agents-section' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'invite-person' }).props.label).toBe('Invite person');
    expect(renderer.root.findByProps({ testID: 'add-agent' }).props.label).toBe('Add agent');
  });
});
