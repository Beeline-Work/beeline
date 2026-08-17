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
  addMember: vi.fn(async () => undefined),
  waitUntilMemberRole: vi.fn(async () => undefined),
}));
const agentPresenceBackfillForWorkspace = vi.hoisted(() => vi.fn(async () => []));

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
    agentPresenceBackfillForWorkspace = agentPresenceBackfillForWorkspace;
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

import { shortMemberNpub } from '@/buzz/member-display';
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
  agentPresenceBackfillForWorkspace.mockResolvedValue([]);
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

  it('shows a single identity line: handle over name over a truncated npub', async () => {
    const withHandle = 'b'.repeat(64);
    const withNameOnly = 'c'.repeat(64);
    const withNeither = 'd'.repeat(64);
    client.communityMembers.mockResolvedValue([
      { pubkey: 'a'.repeat(64), role: 'owner' },
      { pubkey: withHandle, role: 'member' },
      { pubkey: withNameOnly, role: 'member' },
      { pubkey: withNeither, role: 'member' },
    ]);
    client.listPersonProfiles.mockResolvedValue([
      { pubkey: withHandle, name: 'Bob Test', handle: 'bobby', updatedAt: 0, raw: {} },
      { pubkey: withNameOnly, name: 'Carol', updatedAt: 0, raw: {} },
    ]);
    const renderer = await render();

    const handleText = renderer.root.findByProps({ testID: `member-${withHandle}-identity` });
    expect(handleText.props.children).toEqual(['@bobby', '']);

    const nameText = renderer.root.findByProps({ testID: `member-${withNameOnly}-identity` });
    expect(nameText.props.children).toEqual(['Carol', '']);

    const npubText = renderer.root.findByProps({ testID: `member-${withNeither}-identity` });
    expect(npubText.props.children).toEqual([shortMemberNpub(withNeither), '']);
  });

  it('keeps the role switcher hidden until the compact label is tapped, then collapses it after a choice', async () => {
    const target = 'e'.repeat(64);
    client.communityMembers.mockResolvedValue([
      { pubkey: 'a'.repeat(64), role: 'owner' },
      { pubkey: target, role: 'member' },
    ]);
    client.listPersonProfiles.mockResolvedValue([
      { pubkey: target, name: 'Eve', updatedAt: 0, raw: {} },
    ]);
    const renderer = await render();

    expect(renderer.root.findByProps({ testID: `member-${target}-role-label` }).props.children)
      .toBeDefined();
    expect(renderer.root.findAllByProps({ testID: `member-${target}-admin` })).toHaveLength(0);

    await act(async () => {
      renderer.root.findByProps({ testID: `member-${target}-role-label` }).props.onPress();
    });

    expect(renderer.root.findAllByProps({ testID: `member-${target}-role-label` })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: `member-${target}-admin` })).toBeDefined();

    await act(async () => {
      await renderer.root.findByProps({ testID: `member-${target}-admin` }).props.onPress();
    });

    expect(client.addMember).toHaveBeenCalledWith('workspace-1', target, 'admin');
    expect(renderer.root.findAllByProps({ testID: `member-${target}-admin` })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: `member-${target}-role-label` })).toBeDefined();
  });

  it('shows a live agent as online and a dormant agent as offline without dropping either identity', async () => {
    const liveAgentPubkey = 'f'.repeat(64);
    const dormantAgentPubkey = '1'.repeat(64);
    const nowSeconds = Math.floor(Date.now() / 1000);
    client.listAgents.mockResolvedValue([
      { agentId: 'live', communityId: 'workspace-1', displayName: 'joy', pubkey: liveAgentPubkey, createdAt: 0, raw: {} },
      { agentId: 'dormant', communityId: 'workspace-1', displayName: 'sumo', pubkey: dormantAgentPubkey, createdAt: 0, raw: {} },
    ]);
    // Only the live agent has a fresh presence heartbeat in any Room; the
    // dormant one has none anywhere in the Workspace (paired, but its daemon
    // is stopped) — the real distinguishing signal, not a made-up flag.
    agentPresenceBackfillForWorkspace.mockResolvedValue([
      {
        type: 'raw',
        sessionId: 'room-1',
        payload: {
          pubkey: liveAgentPubkey,
          created_at: nowSeconds,
          tags: [
            ['d', 'agent-presence:room-1'],
            ['h', 'room-1'],
            ['t', 'agent-presence'],
            ['agent', liveAgentPubkey],
            ['status', 'online'],
          ],
        },
      },
    ]);

    const renderer = await render();
    // agentPresenceBackfillForWorkspace fans out fire-and-forget (initial
    // load must not block the screen on a slow presence read) — flush its
    // resolution and the resulting state update explicitly.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(agentPresenceBackfillForWorkspace).toHaveBeenCalledWith('workspace-1');
    expect(renderer.root.findByProps({ testID: `agent-${liveAgentPubkey}-identity` })).toBeDefined();
    expect(renderer.root.findByProps({ testID: `agent-${dormantAgentPubkey}-identity` })).toBeDefined();
    expect(
      renderer.root.findByProps({ testID: `agent-${liveAgentPubkey}-presence-label` }).props.children,
    ).toBe('ONLINE');
    expect(
      renderer.root.findByProps({ testID: `agent-${dormantAgentPubkey}-presence-label` }).props.children,
    ).toBe('OFFLINE');
  });
});
