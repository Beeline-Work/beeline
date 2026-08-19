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
  removeAgent: vi.fn(async () => undefined),
  createAgentPairingCode: vi.fn(async () => ({ code: 'abc123', expiresAt: 0 })),
}));
const agentPresenceBackfillForWorkspace = vi.hoisted(() => vi.fn(async () => []));
const scrollTo = vi.hoisted(() => vi.fn());
const agentModelCatalogRead = vi.hoisted(() => vi.fn(async () => null));
const agentModelConfigRead = vi.hoisted(() => vi.fn(async () => null));
const agentModelConfigSet = vi.hoisted(() => vi.fn(async () => undefined));
const mmkvValues = vi.hoisted(() => new Map<string, string>());

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
  useLocalSearchParams: () => ({ communityId: 'workspace-1' }),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('react-native-keyboard-controller', async () => {
  const ReactModule = await import('react');
  const KeyboardAwareScrollView = ReactModule.forwardRef((props: any, ref: any) => {
    ReactModule.useImperativeHandle(ref, () => ({ scrollTo }));
    return ReactModule.createElement('ScrollView', props, props.children);
  });
  return { KeyboardAwareScrollView };
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
    agentModelCatalogRead = agentModelCatalogRead;
    agentModelConfigRead = agentModelConfigRead;
    agentModelConfigSet = agentModelConfigSet;
  },
}));
vi.mock('@/components/buzz/CommunityRail', async () => {
  const ReactModule = await import('react');
  return { BuzzCommunityShell: (props: any) => ReactModule.createElement('BuzzCommunityShell', props, props.children) };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return {
    hairlineDivider: { borderBottomWidth: 1, borderBottomColor: '#4e4e4e' },
    HullSurface: host('HullSurface'),
    HullWaveSignal: host('HullWaveSignal'),
    MonoButton: host('MonoButton'),
    PixelLoader: host('PixelLoader'),
  };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
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

import { prepareWorkspaceContext } from '@/buzz/workspace-bootstrap';
import { shortMemberNpub } from '@/buzz/member-display';
import { useBuzzLocalCache } from '@/buzz/local-cache';
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
  useBuzzLocalCache.getState().clear();
  client.communityMembers.mockResolvedValue([{ pubkey: 'a'.repeat(64), role: 'owner' }]);
  client.removeAgent.mockResolvedValue(undefined);
  agentPresenceBackfillForWorkspace.mockResolvedValue([]);
  agentModelCatalogRead.mockResolvedValue(null);
  agentModelConfigRead.mockResolvedValue(null);
  agentModelConfigSet.mockResolvedValue(undefined);
  scrollTo.mockClear();
  (prepareWorkspaceContext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    workspaces: [{ communityId: 'workspace-1', name: 'Night Shift', viewerRole: 'owner' }],
    activeWorkspaceId: 'workspace-1',
  });
});

/** Nearest TouchableOpacity ancestor — used to select an agent row from its identity text. */
function ancestorButton(node: any): any {
  let current = node;
  while (current && current.type !== 'TouchableOpacity') current = current.parent;
  if (!current) throw new Error('no TouchableOpacity ancestor found');
  return current;
}

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

  it('hides the Model / Effort section when the agent has never published a catalog', async () => {
    const agentPubkey = '2'.repeat(64);
    client.listAgents.mockResolvedValue([
      { agentId: 'a1', communityId: 'workspace-1', displayName: 'joy', pubkey: agentPubkey, createdAt: 0, raw: {} },
    ]);
    const renderer = await render();

    await act(async () => {
      ancestorButton(renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` })).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(agentModelCatalogRead).toHaveBeenCalledWith('workspace-1', agentPubkey);
    expect(renderer.root.findAllByProps({ testID: `agent-${agentPubkey}-model-config` })).toHaveLength(0);
  });

  it('lists the advertised model/effort catalog, never a mode axis, and lets you choose an option', async () => {
    const agentPubkey = '3'.repeat(64);
    client.listAgents.mockResolvedValue([
      { agentId: 'a2', communityId: 'workspace-1', displayName: 'joy', pubkey: agentPubkey, createdAt: 0, raw: {} },
    ]);
    agentModelCatalogRead.mockResolvedValue({
      communityId: 'workspace-1',
      agentPubkey,
      options: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'sonnet',
          options: [{ id: 'sonnet' }, { id: 'opus', name: 'Opus' }],
        },
        {
          id: 'effort',
          category: 'effort',
          currentValue: 'default',
          options: [{ id: 'low' }, { id: 'high' }],
        },
      ],
      updatedAt: 0,
      raw: {},
    });
    agentModelConfigRead.mockResolvedValue({
      communityId: 'workspace-1',
      agentPubkey,
      authoredBy: 'a'.repeat(64),
      model: 'sonnet',
      updatedAt: 0,
      raw: {},
    });
    const renderer = await render();

    await act(async () => {
      ancestorButton(renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` })).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ testID: `agent-${agentPubkey}-model-config` })).toBeDefined();
    // No mode axis was even advertised by the daemon-published catalog (it is
    // filtered before publish) — this asserts the client never renders one.
    expect(renderer.root.findAllByProps({ testID: 'model-axis-mode' })).toHaveLength(0);

    await act(async () => {
      renderer.root.findByProps({ testID: 'model-axis-effort' }).props.onPress();
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'model-option-effort-high' }).props.onPress();
      await Promise.resolve();
    });

    expect(agentModelConfigSet).toHaveBeenCalledWith('workspace-1', agentPubkey, { effort: 'high' });
  });

  it('paints from the local Workspace roster cache before any network read resolves', async () => {
    const cachedAgentPubkey = '6'.repeat(64);
    const cachedPersonPubkey = '7'.repeat(64);
    const viewerPubkey = 'a'.repeat(64);
    useBuzzLocalCache.getState().setActiveViewer(viewerPubkey);
    useBuzzLocalCache.getState().setChannelList({
      viewerPubkey,
      communityId: 'workspace-1',
      channels: [],
      directMessages: [],
      workspaceMembers: [
        { peerPubkey: cachedPersonPubkey, peerName: 'Cached Carol', peerKind: 'person', role: 'member' },
        {
          peerPubkey: cachedAgentPubkey,
          peerName: 'sumo',
          peerKind: 'agent',
          peerAgent: {
            agentId: 'cached-agent',
            communityId: 'workspace-1',
            displayName: 'sumo',
            pubkey: cachedAgentPubkey,
            createdAt: 0,
            raw: {},
          },
        },
      ],
      communities: [{ communityId: 'workspace-1', name: 'Night Shift', viewerRole: 'owner' }],
      personalWorkspaceId: null,
      viewerIsAgent: false,
      canEditWorkspaceAvatar: true,
      updatedAt: 0,
      lastAccessedAt: 0,
    } as any);

    // A slow/absent network: nothing the mount effect awaits ever resolves.
    (prepareWorkspaceContext as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}),
    );

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(MembersScreen));
    });

    expect(renderer.root.findByProps({ testID: `agent-${cachedAgentPubkey}-identity` }).props.children).toBe(
      'sumo',
    );
    expect(renderer.root.findByProps({ testID: `member-${cachedPersonPubkey}-identity` })).toBeDefined();
  });

  it('removes an agent through a pure membership change even while its presence is stale/offline', async () => {
    const agentPubkey = '8'.repeat(64);
    client.listAgents
      .mockResolvedValueOnce([
        { agentId: 'a5', communityId: 'workspace-1', displayName: 'sumo', pubkey: agentPubkey, createdAt: 0, raw: {} },
      ])
      .mockResolvedValue([]);
    // No presence record anywhere in the Workspace: this agent reads offline.
    agentPresenceBackfillForWorkspace.mockResolvedValue([]);
    const renderer = await render();

    await act(async () => {
      ancestorButton(renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` })).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ testID: `agent-${agentPubkey}-offline-notice` })).toBeDefined();

    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Remove this Agent' }).props.onPress();
    });
    await act(async () => {
      renderer.root.findByProps({ label: 'Stop & Remove' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.removeAgent).toHaveBeenCalledWith('workspace-1', agentPubkey);
    expect(renderer.root.findAllByProps({ testID: `agent-${agentPubkey}-identity` })).toHaveLength(0);
  });

  it('never renders a Remove Agent action for a non-admin viewer', async () => {
    const agentPubkey = '9'.repeat(64);
    client.communityMembers.mockResolvedValue([{ pubkey: 'a'.repeat(64), role: 'member' }]);
    client.listAgents.mockResolvedValue([
      { agentId: 'a6', communityId: 'workspace-1', displayName: 'sumo', pubkey: agentPubkey, createdAt: 0, raw: {} },
    ]);
    const renderer = await render();

    await act(async () => {
      ancestorButton(renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` })).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Remove this Agent' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'add-agent' })).toHaveLength(0);
  });

  it('scrolls the pair panel into view when "Add agent" succeeds, even after scrolling past it', async () => {
    const renderer = await render();

    await act(async () => {
      renderer.root.findByProps({ testID: 'add-agent' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.createAgentPairingCode).toHaveBeenCalledWith('workspace-1');
    expect(renderer.root.findByProps({ testID: 'add-agent' })).toBeDefined();
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ y: 0 }));
  });

  it('scrolls the error banner into view when "Add agent" fails', async () => {
    client.createAgentPairingCode.mockRejectedValueOnce(new Error('relay unreachable'));
    const renderer = await render();

    await act(async () => {
      renderer.root.findByProps({ testID: 'add-agent' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ accessibilityRole: 'alert' })).toBeDefined();
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ y: 0 }));
  });
});
