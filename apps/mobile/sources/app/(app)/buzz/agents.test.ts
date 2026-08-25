import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const routeParams = vi.hoisted(() => ({
  current: { communityId: 'workspace-1' } as Record<string, string>,
}));
const client = vi.hoisted(() => ({
  listAgents: vi.fn(async () => []),
  communityMembers: vi.fn(),
  getPersonProfile: vi.fn(async () => undefined),
  listPersonProfiles: vi.fn(async () => []),
  addMember: vi.fn(async () => undefined),
  waitUntilMemberRole: vi.fn(async () => undefined),
  removeAgent: vi.fn(async () => undefined),
  createAgentPairingCode: vi.fn(async () => ({ code: 'abc123', expiresAt: 0 })),
  createInvite: vi.fn(async () => ({ token: 'bzi_test' })),
}));
const agentPresenceBackfillForWorkspace = vi.hoisted(() => vi.fn(async () => []));
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
  useLocalSearchParams: () => routeParams.current,
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('react-native-keyboard-controller', async () => {
  const ReactModule = await import('react');
  return {
    KeyboardAwareScrollView: (props: any) =>
      ReactModule.createElement('ScrollView', props, props.children),
  };
});
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32),
  })),
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
  return {
    BuzzCommunityShell: (props: any) =>
      ReactModule.createElement('BuzzCommunityShell', props, props.children),
  };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
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
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    Share: { share: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

import { prepareWorkspaceContext } from '@/buzz/workspace-bootstrap';
import { shortMemberNpub } from '@/buzz/member-display';
import { useBuzzLocalCache } from '@/buzz/local-cache';
import MembersScreen from './MembersScreen';

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
  routeParams.current = { communityId: 'workspace-1' };
  useBuzzLocalCache.getState().clear();
  client.communityMembers.mockResolvedValue([{ pubkey: 'a'.repeat(64), role: 'owner' }]);
  client.removeAgent.mockResolvedValue(undefined);
  client.createAgentPairingCode.mockResolvedValue({ code: 'abc123', expiresAt: 0 });
  client.createInvite.mockResolvedValue({ token: 'bzi_test' });
  agentPresenceBackfillForWorkspace.mockResolvedValue([]);
  agentModelCatalogRead.mockResolvedValue(null);
  agentModelConfigRead.mockResolvedValue(null);
  agentModelConfigSet.mockResolvedValue(undefined);
  (prepareWorkspaceContext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    workspaces: [{ communityId: 'workspace-1', name: 'Night Shift', viewerRole: 'owner' }],
    activeWorkspaceId: 'workspace-1',
  });
});

/** Every string rendered inside the error banner, joined. */
function errorText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByProps({ accessibilityRole: 'alert' })
    .flatMap((alert: any) => alert.findAllByType('Text'))
    .map((node: any) => (typeof node.props.children === 'string' ? node.props.children : ''))
    .join(' ');
}

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
    expect(renderer.root.findByProps({ testID: 'invite-person' }).props.label).toBe(
      'Invite person',
    );
    expect(renderer.root.findByProps({ testID: 'add-agent' }).props.label).toBe('Add agent');
  });

  it('runs the existing pairing action from the Room-deck Agent deep link', async () => {
    routeParams.current = { communityId: 'workspace-1', action: 'add-agent' };

    const renderer = await render();
    await act(async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });

    expect(client.createAgentPairingCode).toHaveBeenCalledOnce();
    expect(client.createAgentPairingCode).toHaveBeenCalledWith('workspace-1');
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Copy pairing command' }).props.children[0]
        .props.children,
    ).toBe('env -u BUZZ_AGENT_KEY -u BUZZ_PRIVATE_KEY beeline pair abc123');
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

    expect(
      renderer.root.findByProps({ testID: `member-${target}-role-label` }).props.children,
    ).toBeDefined();
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
      {
        agentId: 'live',
        communityId: 'workspace-1',
        displayName: 'joy',
        pubkey: liveAgentPubkey,
        createdAt: 0,
        raw: {},
      },
      {
        agentId: 'dormant',
        communityId: 'workspace-1',
        displayName: 'sumo',
        pubkey: dormantAgentPubkey,
        createdAt: 0,
        raw: {},
      },
    ]);
    // Only the live agent has a fresh presence heartbeat in any Room; the
    // dormant one has none anywhere in the Workspace (paired, but its daemon
    // is stopped) — the real distinguishing signal, not a made-up flag.
    agentPresenceBackfillForWorkspace.mockResolvedValue([
      {
        type: 'read-model',
        sessionId: 'room-1',
        event: {
          type: 'session-update',
          eventId: 'presence-live',
          authorPubkey: liveAgentPubkey,
          createdAt: nowSeconds,
          sourceKind: 30078,
          signature: 'verified',
          scope: 'channel',
          channelId: 'room-1',
          workspaceId: 'workspace-1',
          sessionId: 'room-1',
          update: { kind: 'presence', agentPubkey: liveAgentPubkey, status: 'online' },
        },
      } as never,
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
    expect(
      renderer.root.findByProps({ testID: `agent-${liveAgentPubkey}-identity` }),
    ).toBeDefined();
    expect(
      renderer.root.findByProps({ testID: `agent-${dormantAgentPubkey}-identity` }),
    ).toBeDefined();
    expect(
      renderer.root.findByProps({ testID: `agent-${liveAgentPubkey}-presence-label` }).props
        .children,
    ).toBe('ONLINE');
    expect(
      renderer.root.findByProps({ testID: `agent-${dormantAgentPubkey}-presence-label` }).props
        .children,
    ).toBe('OFFLINE');
  });

  it('accepts an operator-chosen compound agent name, not just one spoken word', async () => {
    const agentPubkey = '4'.repeat(64);
    client.listAgents.mockResolvedValue([
      {
        agentId: 'a3',
        communityId: 'workspace-1',
        displayName: 'joy',
        pubkey: agentPubkey,
        createdAt: 0,
        raw: {},
      },
    ]);
    const renderer = await render();

    await act(async () => {
      ancestorButton(
        renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` }),
      ).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    const save = () => renderer.root.findByProps({ label: 'Save' });
    // A single word still saves.
    expect(save().props.disabled).toBe(false);

    await act(async () => {
      renderer.root.findByProps({ testID: 'agent-soul-name' }).props.onChangeText('Quiet Keeper');
    });
    // A compound an operator actually chose is preserved, not gated out.
    expect(save().props.disabled).toBe(false);

    await act(async () => {
      renderer.root.findByProps({ testID: 'agent-soul-name' }).props.onChangeText('h4x0r');
    });
    expect(save().props.disabled).toBe(true);
  });

  it('darkflights the Agent picture override: the editor offers no picture buttons', async () => {
    // Photo-override darkflight (owner decision, 2026-08-23): even an agent
    // with a stored soul photo gets no 'Set/Change picture' affordance — the
    // generated mark is the only face an Agent can have.
    const agentPubkey = '7'.repeat(64);
    client.listAgents.mockResolvedValue([
      {
        agentId: 'a7',
        communityId: 'workspace-1',
        displayName: 'joy',
        pubkey: agentPubkey,
        createdAt: 0,
        soulProfile: {
          name: 'joy',
          soul: 'Keep the suite green.',
          avatarSeed: agentPubkey,
          avatar: 'https://example.test/joy.png',
        },
        raw: {},
      },
    ]);
    const renderer = await render();

    await act(async () => {
      ancestorButton(
        renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` }),
      ).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ testID: `message-agent-${agentPubkey}` })).toBeDefined();
    const text = renderer.root
      .findAllByType('Text')
      .map((node: any) => (typeof node.props.children === 'string' ? node.props.children : ''))
      .join(' ');
    expect(text).not.toContain('Set picture');
    expect(text).not.toContain('Change picture');
    expect(text).not.toContain('Use generated mark');
  });

  it('offers manual Model / Effort entry even when the agent has never published a catalog', async () => {
    // A missing catalog used to hide the section outright, so a model the
    // harness accepts but does not list could not be configured at all. The
    // fallback axes render with manual entry instead.
    const agentPubkey = '2'.repeat(64);
    client.listAgents.mockResolvedValue([
      {
        agentId: 'a1',
        communityId: 'workspace-1',
        displayName: 'joy',
        pubkey: agentPubkey,
        createdAt: 0,
        raw: {},
      },
    ]);
    const renderer = await render();

    await act(async () => {
      ancestorButton(
        renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` }),
      ).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(agentModelCatalogRead).toHaveBeenCalledWith('workspace-1', agentPubkey);
    expect(
      renderer.root.findByProps({ testID: `agent-${agentPubkey}-model-config` }),
    ).toBeDefined();
    // Fallback axes only: model + effort, never a mode axis.
    expect(renderer.root.findByProps({ testID: 'model-axis-model' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'model-axis-effort' })).toBeDefined();

    await act(async () => {
      renderer.root.findByProps({ testID: 'model-axis-model' }).props.onPress();
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'model-custom-model' }).props.onPress();
    });
    await act(async () => {
      renderer.root
        .findByProps({ testID: 'model-custom-input-model' })
        .props.onChangeText('openrouter/stealth/ox-alpha');
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'model-custom-submit-model' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(agentModelConfigSet).toHaveBeenCalledWith('workspace-1', agentPubkey, {
      model: 'openrouter/stealth/ox-alpha',
    });
  });

  it('lists the advertised model/effort catalog, never a mode axis, and lets you choose an option', async () => {
    const agentPubkey = '3'.repeat(64);
    client.listAgents.mockResolvedValue([
      {
        agentId: 'a2',
        communityId: 'workspace-1',
        displayName: 'joy',
        pubkey: agentPubkey,
        createdAt: 0,
        raw: {},
      },
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
      ancestorButton(
        renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` }),
      ).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root.findByProps({ testID: `agent-${agentPubkey}-model-config` }),
    ).toBeDefined();
    // No mode axis was even advertised by the daemon-published catalog (it is
    // filtered before publish) — this asserts the client never renders one.
    expect(renderer.root.findAllByProps({ testID: 'model-axis-mode' })).toHaveLength(0);

    await act(async () => {
      renderer.root.findByProps({ testID: 'model-axis-model' }).props.onPress();
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'model-option-model-opus' }).props.onPress();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'model-axis-effort' }).props.onPress();
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'model-option-effort-high' }).props.onPress();
      await Promise.resolve();
    });

    expect(agentModelConfigSet).toHaveBeenNthCalledWith(1, 'workspace-1', agentPubkey, {
      model: 'opus',
    });
    expect(agentModelConfigSet).toHaveBeenNthCalledWith(2, 'workspace-1', agentPubkey, {
      effort: 'high',
    });
  });

  it('lets you enter a model id the catalog does not list, and keeps the effort axis alongside it', async () => {
    const agentPubkey = '4'.repeat(64);
    client.listAgents.mockResolvedValue([
      {
        agentId: 'a3',
        communityId: 'workspace-1',
        displayName: 'joy',
        pubkey: agentPubkey,
        createdAt: 0,
        raw: {},
      },
    ]);
    agentModelCatalogRead.mockResolvedValue({
      communityId: 'workspace-1',
      agentPubkey,
      options: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'sonnet',
          options: [{ id: 'sonnet' }],
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
      model: 'openrouter/stealth/ox-alpha',
      effort: 'high',
      updatedAt: 0,
      raw: {},
    });
    const renderer = await render();

    await act(async () => {
      ancestorButton(
        renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` }),
      ).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      renderer.root.findByProps({ testID: 'model-axis-model' }).props.onPress();
    });
    // The custom escape exists even when the catalog has options.
    await act(async () => {
      renderer.root.findByProps({ testID: 'model-custom-model' }).props.onPress();
    });
    await act(async () => {
      renderer.root
        .findByProps({ testID: 'model-custom-input-model' })
        .props.onChangeText('openrouter/stealth/ox-alpha');
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'model-custom-submit-model' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(agentModelConfigSet).toHaveBeenCalledWith('workspace-1', agentPubkey, {
      model: 'openrouter/stealth/ox-alpha',
    });

    // The effort axis survives the custom model: it is still rendered and
    // settable, and the persisted effort shows on the axis row.
    await act(async () => {
      renderer.root.findByProps({ testID: 'model-axis-effort' }).props.onPress();
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'model-option-effort-high' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(agentModelConfigSet).toHaveBeenLastCalledWith('workspace-1', agentPubkey, {
      effort: 'high',
    });
  });

  it('shows a CLI-configured agent its configured values from the published catalog', async () => {
    // THE reported break: `beeline pair --model/--effort` wrote only to the
    // local runtime record, so both rows rendered a dead `—` with no chevron.
    // The daemon now publishes the effective selection on its catalog; the
    // app must show it even with no human-authored config record at all.
    const agentPubkey = '8'.repeat(64);
    client.listAgents.mockResolvedValue([
      {
        agentId: 'a8',
        communityId: 'workspace-1',
        displayName: 'joy',
        pubkey: agentPubkey,
        createdAt: 0,
        raw: {},
      },
    ]);
    agentModelCatalogRead.mockResolvedValue({
      communityId: 'workspace-1',
      agentPubkey,
      options: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'default',
          options: [{ id: 'gpt-5.1-codex' }],
        },
        {
          id: 'effort',
          category: 'effort',
          currentValue: 'default',
          options: [{ id: 'low' }, { id: 'xhigh' }],
        },
      ],
      selection: { model: 'gpt-5.1-codex', effort: 'xhigh' },
      updatedAt: 0,
      raw: {},
    });
    agentModelConfigRead.mockResolvedValue(null);
    const renderer = await render();

    await act(async () => {
      ancestorButton(
        renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` }),
      ).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ testID: 'model-axis-value-model' }).props.children).toBe(
      'gpt-5.1-codex',
    );
    expect(renderer.root.findByProps({ testID: 'model-axis-value-effort' }).props.children).toBe(
      'xhigh',
    );
  });

  it('renders the effort axis as selectable levels, never a free-text input', async () => {
    // Effort values are a small fixed set, so a text field is the wrong
    // affordance even when no catalog has advertised the harness's levels —
    // the fallback offers the common levels instead.
    const agentPubkey = '9'.repeat(64);
    client.listAgents.mockResolvedValue([
      {
        agentId: 'a9',
        communityId: 'workspace-1',
        displayName: 'joy',
        pubkey: agentPubkey,
        createdAt: 0,
        raw: {},
      },
    ]);
    const renderer = await render();

    await act(async () => {
      ancestorButton(
        renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` }),
      ).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      renderer.root.findByProps({ testID: 'model-axis-effort' }).props.onPress();
    });
    for (const level of ['low', 'medium', 'high']) {
      expect(renderer.root.findByProps({ testID: `model-option-effort-${level}` })).toBeDefined();
    }
    // No custom text entry for effort — only the model axis keeps that escape.
    expect(renderer.root.findAllByProps({ testID: 'model-custom-effort' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-custom-input-effort' })).toHaveLength(0);

    await act(async () => {
      renderer.root.findByProps({ testID: 'model-option-effort-medium' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(agentModelConfigSet).toHaveBeenCalledWith('workspace-1', agentPubkey, {
      effort: 'medium',
    });
  });

  it('never renders a dead row: an unknown value says so and every row stays tappable', async () => {
    const agentPubkey = '11'.repeat(2); /* '1111…' */
    client.listAgents.mockResolvedValue([
      {
        agentId: 'a11',
        communityId: 'workspace-1',
        displayName: 'joy',
        pubkey: agentPubkey,
        createdAt: 0,
        raw: {},
      },
    ]);
    const renderer = await render();

    await act(async () => {
      ancestorButton(
        renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` }),
      ).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    for (const axis of ['model', 'effort']) {
      expect(renderer.root.findByProps({ testID: `model-axis-value-${axis}` }).props.children).toBe(
        'Not set — tap to choose',
      );
      // The chevron is the affordance; it must never disappear just because
      // the axis has no advertised options.
      const row = renderer.root.findByProps({ testID: `model-axis-${axis}` });
      expect(row.props.children).toHaveLength(3);
    }
    // And the missing catalog is stated, not silent.
    expect(renderer.root.findByProps({ testID: 'model-catalog-missing' })).toBeDefined();
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
        {
          peerPubkey: cachedPersonPubkey,
          peerName: 'Cached Carol',
          peerKind: 'person',
          role: 'member',
        },
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

    expect(
      renderer.root.findByProps({ testID: `agent-${cachedAgentPubkey}-identity` }).props.children,
    ).toBe('sumo');
    expect(
      renderer.root.findByProps({ testID: `member-${cachedPersonPubkey}-identity` }),
    ).toBeDefined();
  });

  it('removes an agent through a pure membership change even while its presence is stale/offline', async () => {
    const agentPubkey = '8'.repeat(64);
    client.listAgents
      .mockResolvedValueOnce([
        {
          agentId: 'a5',
          communityId: 'workspace-1',
          displayName: 'sumo',
          pubkey: agentPubkey,
          createdAt: 0,
          raw: {},
        },
      ])
      .mockResolvedValue([]);
    // No presence record anywhere in the Workspace: this agent reads offline.
    agentPresenceBackfillForWorkspace.mockResolvedValue([]);
    const renderer = await render();

    await act(async () => {
      ancestorButton(
        renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` }),
      ).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root.findByProps({ testID: `agent-${agentPubkey}-offline-notice` }),
    ).toBeDefined();

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
    expect(renderer.root.findAllByProps({ testID: `agent-${agentPubkey}-identity` })).toHaveLength(
      0,
    );
  });

  it('never renders a Remove Agent action for a non-admin viewer', async () => {
    const agentPubkey = '9'.repeat(64);
    client.communityMembers.mockResolvedValue([{ pubkey: 'a'.repeat(64), role: 'member' }]);
    client.listAgents.mockResolvedValue([
      {
        agentId: 'a6',
        communityId: 'workspace-1',
        displayName: 'sumo',
        pubkey: agentPubkey,
        createdAt: 0,
        raw: {},
      },
    ]);
    const renderer = await render();

    await act(async () => {
      ancestorButton(
        renderer.root.findByProps({ testID: `agent-${agentPubkey}-identity` }),
      ).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Remove this Agent' })).toHaveLength(
      0,
    );
    expect(renderer.root.findAllByProps({ testID: 'add-agent' })).toHaveLength(0);
  });

  // #232 made this screen paint from the roster cache, so an owner's admin
  // controls render before the init effect has a transport. Before this fix
  // every handler began `if (!transport ...) return`, so each of these taps was
  // a silent no-op for the whole connect window (and forever if init threw).
  describe('per-action pending state', () => {
    it('animates only the tapped control, and still gates every other one', async () => {
      const viewerPubkey = 'a'.repeat(64);
      useBuzzLocalCache.getState().setActiveViewer(viewerPubkey);
      useBuzzLocalCache.getState().setChannelList({
        viewerPubkey,
        communityId: 'workspace-1',
        channels: [],
        directMessages: [],
        workspaceMembers: [
          { peerPubkey: viewerPubkey, peerName: 'Owner', peerKind: 'person', role: 'owner' },
        ],
        communities: [{ communityId: 'workspace-1', name: 'Night Shift', viewerRole: 'owner' }],
        personalWorkspaceId: null,
        viewerIsAgent: false,
        canEditWorkspaceAvatar: true,
        updatedAt: 0,
        lastAccessedAt: 0,
      } as any);
      // A pairing code that never resolves holds "Add agent" in flight for
      // the whole assertion window.
      client.createAgentPairingCode.mockImplementation(() => new Promise(() => undefined));

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(React.createElement(MembersScreen));
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      });

      await act(async () => {
        renderer.root.findByProps({ testID: 'add-agent' }).props.onPress();
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      });

      const addAgent = renderer.root.findByProps({ testID: 'add-agent' });
      const invitePerson = renderer.root.findByProps({ testID: 'invite-person' });
      // Only the tapped control spins and relabels...
      expect(addAgent.props.loading).toBe(true);
      expect(addAgent.props.label).toBe('Adding agent');
      expect(invitePerson.props.loading).toBe(false);
      expect(invitePerson.props.label).toBe('Invite person');
      // ...while the concurrency intent is unchanged: both stay disabled.
      expect(addAgent.props.disabled).toBe(true);
      expect(invitePerson.props.disabled).toBe(true);
    });
  });

  describe('admin actions taken before the transport has connected', () => {
    function seedOwnerCache() {
      const viewerPubkey = 'a'.repeat(64);
      useBuzzLocalCache.getState().setActiveViewer(viewerPubkey);
      useBuzzLocalCache.getState().setChannelList({
        viewerPubkey,
        communityId: 'workspace-1',
        channels: [],
        directMessages: [],
        workspaceMembers: [
          { peerPubkey: viewerPubkey, peerName: 'Owner', peerKind: 'person', role: 'owner' },
        ],
        communities: [{ communityId: 'workspace-1', name: 'Night Shift', viewerRole: 'owner' }],
        personalWorkspaceId: null,
        viewerIsAgent: false,
        canEditWorkspaceAvatar: true,
        updatedAt: 0,
        lastAccessedAt: 0,
      } as any);
    }

    it('waits for the pending connection and then executes, instead of swallowing the tap', async () => {
      seedOwnerCache();
      let releaseWorkspace!: (value: unknown) => void;
      (prepareWorkspaceContext as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseWorkspace = resolve;
          }),
      );

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(React.createElement(MembersScreen));
      });

      // The cache-seeded owner sees the controls while init is still in flight.
      expect(renderer.root.findByProps({ testID: 'add-agent' })).toBeDefined();
      await act(async () => {
        renderer.root.findByProps({ testID: 'add-agent' }).props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(client.createAgentPairingCode).not.toHaveBeenCalled();
      // The tap is held, not dropped: the button reports work in progress.
      expect(renderer.root.findByProps({ testID: 'add-agent' }).props.loading).toBe(true);

      await act(async () => {
        releaseWorkspace({
          workspaces: [{ communityId: 'workspace-1', name: 'Night Shift', viewerRole: 'owner' }],
          activeWorkspaceId: 'workspace-1',
        });
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      });

      expect(client.createAgentPairingCode).toHaveBeenCalledWith('workspace-1');
      expect(renderer.root.findByProps({ testID: 'add-agent' }).props.loading).toBe(false);
    });

    it('runs a queued "Invite person" once the connection lands', async () => {
      seedOwnerCache();
      client.createInvite.mockResolvedValue({ token: 'bzi_test' });
      let releaseWorkspace!: (value: unknown) => void;
      (prepareWorkspaceContext as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseWorkspace = resolve;
          }),
      );

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(React.createElement(MembersScreen));
      });

      await act(async () => {
        renderer.root.findByProps({ testID: 'invite-person' }).props.onPress();
        await Promise.resolve();
      });
      expect(client.createInvite).not.toHaveBeenCalled();

      await act(async () => {
        releaseWorkspace({
          workspaces: [{ communityId: 'workspace-1', name: 'Night Shift', viewerRole: 'owner' }],
          activeWorkspaceId: 'workspace-1',
        });
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      });

      expect(client.createInvite).toHaveBeenCalledWith('workspace-1');
    });

    it('surfaces the real init failure to a queued tap instead of returning silently', async () => {
      seedOwnerCache();
      let failWorkspace!: (reason: unknown) => void;
      (prepareWorkspaceContext as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            failWorkspace = reject;
          }),
      );

      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(React.createElement(MembersScreen));
      });

      await act(async () => {
        renderer.root.findByProps({ testID: 'add-agent' }).props.onPress();
        await Promise.resolve();
      });

      await act(async () => {
        failWorkspace(new Error('relay unreachable'));
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      });

      expect(client.createAgentPairingCode).not.toHaveBeenCalled();
      expect(renderer.root.findAllByProps({ accessibilityRole: 'alert' }).length).toBeGreaterThan(
        0,
      );
      // The discriminating assertion: the banner carries the *handler's* own
      // failure text, proving the queued tap reached its catch. A silent return
      // leaves only the init effect's bare `String(caught)` message behind.
      expect(errorText(renderer)).toContain('Could not create pairing code');
      expect(errorText(renderer)).toContain('relay unreachable');
      expect(renderer.root.findByProps({ testID: 'add-agent' }).props.loading).toBe(false);
    });
  });

  describe('viewer with key succession', () => {
    it('renders owner affordances from the succession-aware roster, with the dead predecessor gone', async () => {
      const predecessorKey = '9'.repeat(64);
      const viewerKey = 'a'.repeat(64);
      // What the succession-aware communityMembers resolver now returns: the
      // CURRENT key carries owner and the dead create-author predecessor is
      // not in the roster at all (never both keys).
      client.communityMembers.mockResolvedValue([{ pubkey: viewerKey, role: 'owner' }]);
      // Workspace discovery had no chain available, so no viewerRole came
      // back on the community record — management gating must come from the
      // roster read alone.
      (prepareWorkspaceContext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspaces: [
          {
            communityId: 'workspace-1',
            name: 'Night Shift',
            ownerPubkey: predecessorKey,
          },
        ],
        activeWorkspaceId: 'workspace-1',
      });

      const renderer = await render();

      // Management affordances: isWorkspaceManagerRole(viewerRole) true.
      expect(renderer.root.findByProps({ testID: 'invite-person' })).toBeDefined();
      expect(renderer.root.findByProps({ testID: 'add-agent' })).toBeDefined();
      // The viewer's own owner badge, not a least-privileged member stub.
      const roleLabel = renderer.root.findByProps({ testID: `member-${viewerKey}-role-label` });
      // testID sits on the wrapping button; its accessibility label carries
      // the rendered role word (the nested Text mocks defeat children reads).
      expect(roleLabel.props.accessibilityLabel).toContain('role: OWNER');
      // The dead predecessor renders nowhere.
      expect(
        renderer.root.findAllByProps({ testID: `member-${predecessorKey}-identity` }),
      ).toHaveLength(0);
      expect(renderer.root.findByProps({ testID: 'members-people-count' }).props.children).toBe(1);
    });
  });
});
