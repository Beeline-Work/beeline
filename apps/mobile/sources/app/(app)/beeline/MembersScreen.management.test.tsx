import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const VIEWER = 'a'.repeat(64);
const OWNER = 'b'.repeat(64);
const MEMBER = 'c'.repeat(64);
const AGENT = 'd'.repeat(64);

const state = vi.hoisted(() => ({ workspace: null as any, agent: null as any }));
const roomView = vi.hoisted(() => ({ workspace: vi.fn(), agent: vi.fn() }));
const share = vi.hoisted(() => vi.fn(async () => undefined));
const modal = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  prompt: vi.fn(async () => null as string | null),
}));
const client = vi.hoisted(() => ({
  surfaceSubscribe: vi.fn(async () => vi.fn()),
  createInvite: vi.fn(async () => ({ token: `inv_${'e'.repeat(64)}` })),
  createAgentPairingCode: vi.fn(async () => ({
    code: '1234ABCD-5678EF90',
    expiresAt: 2_000_000_000,
  })),
  addMember: vi.fn(async (_workspaceId: string, pubkey: string, role: string) => {
    state.workspace = {
      ...state.workspace,
      members: state.workspace.members.map((member: any) =>
        member.identity.pubkey === pubkey ? { ...member, role } : member,
      ),
    };
  }),
  waitUntilMemberRole: vi.fn(async () => undefined),
  setAgentModelConfig: vi.fn(async (_workspaceId: string, _pubkey: string, input: any) => {
    state.agent = { ...state.agent, selected: { ...state.agent.selected, ...input } };
  }),
  setAgentSoul: vi.fn(async (_workspaceId: string, pubkey: string, soul: any) => {
    state.agent = {
      ...state.agent,
      agent: {
        ...state.agent.agent,
        identity: { ...state.agent.agent.identity, name: soul.name },
      },
      soul: { name: soul.name, instructions: soul.soul, avatarSeed: soul.avatarSeed },
    };
    state.workspace = {
      ...state.workspace,
      agents: state.workspace.agents.map((member: any) =>
        member.identity.pubkey === pubkey
          ? { ...member, identity: { ...member.identity, name: soul.name } }
          : member,
      ),
    };
  }),
  removeAgent: vi.fn(async (_workspaceId: string, pubkey: string) => {
    state.workspace = {
      ...state.workspace,
      agents: state.workspace.agents.filter((member: any) => member.identity.pubkey !== pubkey),
    };
  }),
  removeMember: vi.fn(async (_workspaceId: string, pubkey: string) => {
    state.workspace = {
      ...state.workspace,
      members: state.workspace.members.filter((member: any) => member.identity.pubkey !== pubkey),
    };
  }),
}));

const phoneOperation = vi.hoisted(() =>
  vi.fn(async (name: string, input: any) => {
    if (name === 'revokeAgentGrant') {
      state.agent = {
        ...state.agent,
        grants: state.agent.grants.map((grant: any) =>
          grant.grantId === input.grantId ? { ...grant, status: 'revoked' } : grant,
        ),
      };
      return { grantId: input.grantId, status: 'revoked', roomId: 'room' };
    }
    if (name !== 'updateAgentYolo') throw new Error(`unexpected operation ${name}`);
    state.agent = {
      ...state.agent,
      yolo: {
        ...state.agent.yolo,
        enabled: input.enabled,
        setBy: { name: 'Viewer' },
        setAt: 1_756_684_800,
      },
    };
  }),
);
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));

vi.mock('expo-router', () => ({
  router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
  useLocalSearchParams: () => ({ communityId: WORKSPACE }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('react-native-keyboard-controller', async () => {
  const ReactModule = await import('react');
  return {
    KeyboardAwareScrollView: (props: any) =>
      ReactModule.createElement('KeyboardAwareScrollView', props, props.children),
  };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Share: { share },
    ScrollView: host('ScrollView'),
    Switch: host('Switch'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
const unistylesTheme = vi.hoisted(() => ({
  buzz: {
    type: {
      hero: { fontSize: 22 },
      body: { fontSize: 16 },
      meta: { fontSize: 13 },
      sectionHead: { fontSize: 10 },
      machine: { fontSize: 13 },
    },
    space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
    layout: { row: 64, sectionGap: 24 },
    radius: 3,
    dialogDanger: '#c4544d',
    bgTerminal: '#000',
    bgRaised: '#111',
    bgPressed: '#222',
    textMuted: '#888',
    textPrimary: '#fff',
    border: '#333',
    chrome: '#aaa',
    accent: '#d7af5f',
    danger: '#f00',
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) => factory(unistylesTheme),
  },
  useUnistyles: () => ({ theme: unistylesTheme }),
}));
vi.mock('@/constants/Typography', () => ({
  Typography: { mono: () => ({}), default: () => ({}) },
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: VIEWER, secretKey: new Uint8Array(32) })),
}));
vi.mock('@/buzz/surface-storage', () => ({
  mobileSurfaceCache: { read: vi.fn(async () => null), write: vi.fn(async () => undefined) },
  surfaceAddress: vi.fn(() => 'surface-address'),
}));
vi.mock('@/buzz/room-view-presentation', () => ({ workspaceRailItem: (value: any) => value }));
vi.mock('@/components/buzz/CommunityRail', async () => {
  const ReactModule = await import('react');
  return {
    BuzzCommunityShell: (props: any) =>
      ReactModule.createElement('BuzzCommunityShell', props, props.children),
  };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    BrassButton: host('BrassButton'),
    HullSurface: host('HullSurface'),
    MonoButton: host('MonoButton'),
    PixelLoader: host('PixelLoader'),
  };
});
vi.mock('@/components/buzz/MemberPickerSheet', async () => {
  const ReactModule = await import('react');
  return {
    MemberPickerSheet: (props: any) => ReactModule.createElement('MemberPickerSheet', props),
  };
});
vi.mock('@/modal/ModalManager', () => ({ Modal: modal }));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => client);
  },
}));
vi.mock('@beeline/buzz-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@beeline/buzz-client')>();
  class RoomViewClient {
    workspace = roomView.workspace;
    agent = roomView.agent;
  }
  class SurfaceRefreshScheduler<T> {
    constructor(
      private readonly options: {
        fetch: () => Promise<T>;
        apply: (value: T) => void;
        onError: (reason: unknown) => void;
      },
    ) {}
    async startAfter(wait: Promise<unknown>) {
      await wait;
      try {
        this.options.apply(await this.options.fetch());
      } catch (reason) {
        this.options.onError(reason);
      }
    }
    force() {
      void this.options.fetch().then(this.options.apply, this.options.onError);
    }
    signal() {
      this.force();
    }
    dispose() {}
  }
  return { ...actual, RoomViewClient, SurfaceRefreshScheduler };
});

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

function member(pubkey: string, name: string, role: 'owner' | 'admin' | 'member') {
  return { identity: { pubkey, kind: 'human', name, handle: name.toLowerCase() }, role };
}

function baseWorkspace(viewerRole: 'owner' | 'admin' = 'owner') {
  return {
    workspace: {
      id: WORKSPACE,
      name: 'Builders',
      visibility: 'invite-only',
      role: viewerRole,
      updatedAt: 1,
      createdAt: 1,
    },
    members: [
      member(VIEWER, 'Viewer', viewerRole),
      member(OWNER, 'Captain', 'owner'),
      member(MEMBER, 'Builder', 'member'),
    ],
    agents: [
      {
        identity: { pubkey: AGENT, kind: 'agent', name: 'Clara', handle: 'clara' },
        role: 'member',
        presence: { status: 'online', observedAt: 1 },
      },
    ],
    membersTruncated: false,
    agentsTruncated: false,
    viewer: {
      identity: { pubkey: VIEWER, kind: 'human', name: 'Viewer' },
      role: viewerRole,
      permissions: { send: true, manage: true },
    },
    watchFilters: [],
  };
}

function baseAgent() {
  return {
    workspaceId: WORKSPACE,
    agent: { identity: { pubkey: AGENT, kind: 'agent', name: 'Clara' }, role: 'member' },
    soul: { name: 'Clara', instructions: 'Keep the tests green.', avatarSeed: AGENT },
    catalog: [
      {
        id: 'model',
        category: 'model',
        currentValue: 'sonnet',
        options: [
          { id: 'sonnet', name: 'Sonnet' },
          { id: 'opus', name: 'Opus' },
        ],
      },
      {
        id: 'effort',
        category: 'reasoning_effort',
        currentValue: 'low',
        options: [{ id: 'low' }, { id: 'high' }],
      },
      { id: 'mode', category: 'mode', options: [{ id: 'bypassPermissions' }] },
    ],
    selected: { model: 'sonnet', effort: 'low' },
    yolo: { enabled: false, canChange: true },
    watchFilters: [],
  };
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(MembersScreen));
  });
  return renderer;
}

async function press(renderer: ReactTestRenderer, testID: string): Promise<void> {
  await act(async () => {
    await renderer.root.findByProps({ testID }).props.onPress();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.workspace = baseWorkspace();
  state.agent = baseAgent();
  roomView.workspace.mockImplementation(async () => state.workspace);
  roomView.agent.mockImplementation(async () => state.agent);
  modal.confirm.mockResolvedValue(true);
  modal.prompt.mockResolvedValue(null);
});

function sheet(renderer: ReactTestRenderer) {
  return renderer.root.findByType('MemberPickerSheet' as any);
}

describe('Members workspace management', () => {
  it('draws no gold ring on an agent whose only fact is a live presence lease', async () => {
    // C77: the ring means WORKING (a live turn or corner). The Workspace view
    // carries presence only, so an online-but-idle agent wears no ring; the
    // lowercase presence word ending the meta line is the presence fact.
    const renderer = await render();
    const agentRow = renderer.root.findByProps({ testID: `agent-${AGENT}-identity` });
    const mark = agentRow.findByType('IdentityMark' as any);
    expect(mark.props.kind).toBe('agent');
    expect(mark.props.alive).toBeFalsy();
    expect(agentRow.findAllByType('Text' as any)[1].props.children).toBe('@clara · member · online');
  });

  it('shares a real Workspace invite directly from the PEOPLE section head +', async () => {
    const renderer = await render();
    expect(sheet(renderer).props.visible).toBe(false);
    // No Room is in scope here: the sheet carries only the Workspace-level ways in.
    expect(sheet(renderer).props.candidates).toBeUndefined();
    await press(renderer, 'members-add-people');

    expect(client.createInvite).toHaveBeenCalledWith(WORKSPACE);
    expect(share).toHaveBeenCalledWith({
      message: `https://relay.test/join/inv_${'e'.repeat(64)}`,
    });
    expect(renderer.root.findAllByProps({ testID: 'invite-person' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'invite-agent' })).toHaveLength(0);
  });

  it('opens the pairing sheet directly from the AGENTS section head +', async () => {
    const renderer = await render();
    expect(sheet(renderer).props.visible).toBe(false);
    await press(renderer, 'members-add-agents');
    expect(sheet(renderer).props.visible).toBe(true);
    expect(client.createAgentPairingCode).toHaveBeenCalledWith(WORKSPACE);
  });

  it('gives a non-manager neither section head + and no full-width brass row', async () => {
    state.workspace = {
      ...baseWorkspace(),
      viewer: {
        ...baseWorkspace().viewer,
        role: 'member',
        permissions: { send: true, manage: false },
      },
    };
    const renderer = await render();
    expect(renderer.root.findAllByProps({ testID: 'members-add-people' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'members-add-agents' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'add-members' })).toHaveLength(0);
    expect(renderer.root.findAllByType('BrassButton' as any)).toHaveLength(0);
  });

  it('names the action and the kind on each section head +, with a 44pt hit area', async () => {
    const renderer = await render();
    const people = renderer.root.findByProps({ testID: 'members-add-people' });
    const agents = renderer.root.findByProps({ testID: 'members-add-agents' });
    expect(people.props.accessibilityLabel).toBe('Add people');
    expect(agents.props.accessibilityLabel).toBe('Add agents');
    expect(people.props.style.minHeight).toBeGreaterThanOrEqual(44);
    expect(agents.props.style.minHeight).toBeGreaterThanOrEqual(44);
  });

  it('shows the word alone over counted section heads and no loose total (C73, C79)', async () => {
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'members-title' }).props.children).toBe('Members');
    expect(renderer.root.findByProps({ testID: 'members-people-head' }).props.children).toEqual([
      'People ',
      3,
    ]);
    expect(renderer.root.findByProps({ testID: 'members-agents-head' }).props.children).toEqual([
      'Agents ',
      1,
    ]);
    const surface = renderer.root.findByProps({ testID: 'workspace-members-surface' });
    const texts = surface.findAllByType('Text' as any).map((node: any) => node.props.children);
    expect(texts).not.toContain(4);
    expect(texts.flat().join(' ')).not.toMatch(/⌬|ONLINE|OFFLINE|MEMBER\b/);
  });

  it('gives every row a name and one quiet @handle · role line; the ring is the only agent state', async () => {
    const renderer = await render();
    const agentRow = renderer.root.findByProps({ testID: `agent-${AGENT}-identity` });
    const agentTexts = agentRow.findAllByType('Text' as any).map((node: any) => node.props.children);
    expect(agentTexts).toEqual(['Clara', '@clara · member · online', '›']);
    expect(agentRow.findByType('IdentityMark' as any).props.alive).toBeFalsy();
    const personRow = renderer.root.findByProps({ testID: `member-${MEMBER}-identity` });
    expect(personRow.findAllByType('Text' as any).map((node: any) => node.props.children)).toEqual([
      'Builder',
      '@builder · member',
      '›',
    ]);
    // The viewer's own row has no detail, so no chevron.
    const selfRow = renderer.root.findByProps({ testID: `member-${VIEWER}-identity` });
    expect(selfRow.props.disabled).toBe(true);
    expect(selfRow.findAllByType('Text' as any).map((node: any) => node.props.children)).toEqual([
      'Viewer',
      '@viewer · owner',
    ]);
  });

  it('keeps removal on the row detail and removes a person from the Workspace through it', async () => {
    const renderer = await render();
    expect(renderer.root.findAllByProps({ testID: `remove-person-${MEMBER}` })).toHaveLength(0);
    await press(renderer, `member-${MEMBER}-identity`);
    expect(
      renderer.root.findByProps({ testID: `remove-person-${MEMBER}` }).findByType('Text' as any)
        .props.children,
    ).toBe('Remove from Workspace');
    await press(renderer, `remove-person-${MEMBER}`);

    expect(modal.confirm).toHaveBeenCalledWith(
      'Remove Builder?',
      expect.stringMatching(/every Room/),
      { cancelText: 'Cancel', confirmText: 'Remove', destructive: true },
    );
    expect(client.removeMember).toHaveBeenCalledWith(WORKSPACE, MEMBER);
    expect(renderer.root.findAllByProps({ testID: `member-${MEMBER}-identity` })).toHaveLength(0);
  });

  it('offers an admin no removal of an owner or another admin', async () => {
    state.workspace = {
      ...baseWorkspace('admin'),
      members: [member(VIEWER, 'Viewer', 'admin'), member(OWNER, 'Captain', 'owner'), member(MEMBER, 'Builder', 'admin')],
    };
    const renderer = await render();
    await press(renderer, `member-${MEMBER}-identity`);
    expect(renderer.root.findAllByProps({ testID: `member-${MEMBER}-roles` }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: `remove-person-${MEMBER}` })).toHaveLength(0);
    expect(client.removeMember).not.toHaveBeenCalled();
  });

  it('lets an admin change a member role but exposes no editor for an owner', async () => {
    state.workspace = baseWorkspace('admin');
    const renderer = await render();

    expect(renderer.root.findByProps({ testID: `member-${OWNER}-identity` }).props.disabled).toBe(
      true,
    );
    await press(renderer, `member-${MEMBER}-identity`);
    expect(renderer.root.findByProps({ testID: `member-${MEMBER}-owner` }).props.disabled).toBe(
      true,
    );
    await press(renderer, `member-${MEMBER}-admin`);

    expect(client.addMember).toHaveBeenCalledWith(WORKSPACE, MEMBER, 'admin');
    expect(client.waitUntilMemberRole).toHaveBeenCalledWith(WORKSPACE, MEMBER, 'admin');
  });

  it('renders MODEL and EFFORT rows with the live catalog as a typeahead chooser', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    expect(renderer.root.findAllByProps({ testID: 'model-axis-mode' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-config-activation-note' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-catalog-missing' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-applies-model' })).toHaveLength(0);
    await press(renderer, 'model-axis-effort');
    expect(renderer.root.findAllByProps({ testID: 'model-option-effort-xhigh' })).toHaveLength(0);
    await press(renderer, 'model-option-effort-high');
    expect(client.setAgentModelConfig).toHaveBeenCalledWith(WORKSPACE, AGENT, { effort: 'high' });
    expect(renderer.root.findByProps({ testID: 'model-applies-effort' }).props.children).toBe(
      'Applies at the next session',
    );

    await press(renderer, 'model-axis-model');
    await act(async () => {
      renderer.root.findByProps({ testID: 'model-search-model' }).props.onChangeText('opu');
    });
    expect(renderer.root.findByProps({ testID: 'model-option-model-opus' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'model-option-model-sonnet' })).toHaveLength(0);
    await press(renderer, 'model-option-model-opus');
    expect(client.setAgentModelConfig).toHaveBeenCalledWith(WORKSPACE, AGENT, {
      model: 'opus',
      effort: null,
    });
    // After a model switch the catalog's effort axis no longer applies; the
    // row stays, offering the generic ladder until a fresh catalog arrives.
    await press(renderer, 'model-axis-effort');
    expect(renderer.root.findByProps({ testID: 'model-option-effort-xhigh' })).toBeDefined();
  });

  it('keeps the catalog default effort atomically when selecting its live model', async () => {
    state.agent = {
      ...baseAgent(),
      catalog: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'opus',
          options: [{ id: 'sonnet' }, { id: 'opus' }],
        },
        {
          id: 'effort',
          category: 'reasoning_effort',
          currentValue: 'high',
          options: [{ id: 'low' }, { id: 'high' }],
        },
      ],
      selected: { model: 'sonnet', effort: 'low' },
    };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    await press(renderer, 'model-axis-model');
    await press(renderer, 'model-option-model-opus');

    expect(client.setAgentModelConfig).toHaveBeenCalledWith(WORKSPACE, AGENT, {
      model: 'opus',
      effort: 'high',
    });
  });

  it('shows the current selection with an empty catalog and takes a typed model id', async () => {
    state.agent = {
      ...baseAgent(),
      catalog: [],
      selected: { model: 'openrouter/z-ai/glm-5.3-flash' },
    };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    expect(renderer.root.findAllByProps({ testID: 'model-catalog-missing' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-config-activation-note' })).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'model-axis-model' }).props.children[1].props.children,
    ).toBe('openrouter/z-ai/glm-5.3-flash');
    expect(
      renderer.root.findByProps({ testID: 'model-axis-effort' }).props.children[1].props.children,
    ).toBe('—');

    await press(renderer, 'model-axis-model');
    const input = renderer.root.findByProps({ testID: 'model-search-model' });
    expect(input.props.placeholder).toBe('Model id');
    await act(async () => {
      input.props.onChangeText('openrouter/openai/gpt-5.6');
    });
    await act(async () => {
      await renderer.root.findByProps({ testID: 'model-search-model' }).props.onSubmitEditing();
    });
    expect(client.setAgentModelConfig).toHaveBeenCalledWith(WORKSPACE, AGENT, {
      model: 'openrouter/openai/gpt-5.6',
      effort: null,
    });
    expect(renderer.root.findByProps({ testID: 'model-applies-model' })).toBeDefined();
  });

  it('offers the generic effort ladder without a catalog and drops the note after 4s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      state.agent = { ...baseAgent(), catalog: [], selected: undefined };
      const renderer = await render();
      await press(renderer, `agent-${AGENT}-identity`);
      expect(
        renderer.root.findByProps({ testID: 'model-axis-model' }).props.children[1].props.children,
      ).toBe('—');

      await press(renderer, 'model-axis-effort');
      expect(renderer.root.findByProps({ testID: 'model-option-effort-low' })).toBeDefined();
      expect(renderer.root.findByProps({ testID: 'model-option-effort-xhigh' })).toBeDefined();
      await press(renderer, 'model-option-effort-xhigh');
      expect(client.setAgentModelConfig).toHaveBeenCalledWith(WORKSPACE, AGENT, {
        effort: 'xhigh',
      });
      expect(renderer.root.findByProps({ testID: 'model-applies-effort' })).toBeDefined();
      await act(async () => {
        vi.advanceTimersByTime(4_000);
      });
      expect(renderer.root.findAllByProps({ testID: 'model-applies-effort' })).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('edits the human-authored soul fields through setAgentSoul', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    await press(renderer, 'edit-agent-soul');
    await act(async () => {
      renderer.root.findByProps({ testID: 'agent-soul-name' }).props.onChangeText('Scout');
      renderer.root
        .findByProps({ testID: 'agent-soul-instructions' })
        .props.onChangeText('Look for regressions before shipping.');
    });
    await press(renderer, 'save-agent-soul');

    expect(client.setAgentSoul).toHaveBeenCalledWith(WORKSPACE, AGENT, {
      name: 'Scout',
      soul: 'Look for regressions before shipping.',
      avatarSeed: AGENT,
    });
  });

  it('uses pencil and close glyph controls instead of boxed rename and close actions', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    expect(
      renderer.root.findByProps({ testID: 'edit-agent-soul' }).findByType('Text').props.children,
    ).toBe('✎');
    expect(
      renderer.root.findByProps({ testID: 'close-agent-settings' }).findByType('Text').props
        .children,
    ).toBe('×');
    expect(renderer.root.findAllByProps({ testID: 'rename-agent' })).toHaveLength(0);
    await press(renderer, 'close-agent-settings');
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);
  });

  it('lets the owner or a workspace admin flip yolo and shows who set it', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    const toggle = renderer.root.findByProps({ testID: 'agent-yolo-switch' });
    expect(toggle.props.disabled).toBe(false);
    expect(toggle.props.value).toBe(false);
    expect(toggle.props.trackColor).toEqual({ false: '#111', true: '#d7af5f' });
    expect(renderer.root.findByProps({ testID: 'agent-yolo-caption' }).props.children).toBe(
      'Grant requests are approved without asking. Only the owner or a workspace admin can change this.',
    );
    expect(renderer.root.findAllByProps({ testID: 'agent-yolo-set-by' })).toHaveLength(0);

    await act(async () => {
      await toggle.props.onValueChange(true);
    });

    expect(phoneOperation).toHaveBeenCalledWith('updateAgentYolo', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      enabled: true,
    });
    expect(renderer.root.findByProps({ testID: 'agent-yolo-switch' }).props.value).toBe(true);
    const setBy = renderer.root.findByProps({ testID: 'agent-yolo-set-by' }).props.children;
    expect(setBy).toMatch(/^Set by Viewer · /);
    expect(setBy).toContain('2025');
    expect(renderer.root.findAllByProps({ testID: 'agent-yolo-error' })).toHaveLength(0);
  });

  it('renders the yolo switch disabled with the same caption for a plain member', async () => {
    state.workspace = {
      ...baseWorkspace(),
      viewer: {
        ...baseWorkspace().viewer,
        role: 'member',
        permissions: { send: true, manage: false },
      },
    };
    state.agent = {
      ...baseAgent(),
      yolo: { enabled: true, canChange: false, setBy: { name: 'Captain' }, setAt: 1_756_684_800 },
    };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    const toggle = renderer.root.findByProps({ testID: 'agent-yolo-switch' });
    expect(toggle.props.disabled).toBe(true);
    expect(toggle.props.value).toBe(true);
    expect(renderer.root.findByProps({ testID: 'agent-yolo-caption' }).props.children).toBe(
      'Grant requests are approved without asking. Only the owner or a workspace admin can change this.',
    );
    expect(renderer.root.findByProps({ testID: 'agent-yolo-set-by' }).props.children).toMatch(
      /^Set by Captain · /,
    );
  });

  it('flips yolo optimistically and rolls back with the server message when refused', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    let settle!: () => void;
    const pending = new Promise<void>((resolve) => (settle = resolve));
    phoneOperation.mockImplementationOnce(async () => {
      await pending;
      throw Object.assign(new Error('Monolith updateAgentYolo failed (403)'), {
        code: "Only the agent's owner or a workspace admin can change this",
      });
    });
    let flip!: Promise<void>;
    await act(async () => {
      flip = renderer.root.findByProps({ testID: 'agent-yolo-switch' }).props.onValueChange(true);
    });
    // Optimistic: on before the server answers.
    expect(renderer.root.findByProps({ testID: 'agent-yolo-switch' }).props.value).toBe(true);
    await act(async () => {
      settle();
      await flip;
    });
    // Rolled back with the server's plain message inline.
    expect(renderer.root.findByProps({ testID: 'agent-yolo-switch' }).props.value).toBe(false);
    expect(renderer.root.findByProps({ testID: 'agent-yolo-error' }).props.children).toBe(
      "Only the agent's owner or a workspace admin can change this",
    );
    expect(roomView.agent).toHaveBeenCalled();
  });

  it('warns about and invokes the full removeAgent host teardown path', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    await press(renderer, 'remove-agent');

    expect(modal.confirm).toHaveBeenCalledWith(
      'Remove Clara?',
      expect.stringMatching(
        /every Room.*paired host.*drains active sessions.*runtime configuration/i,
      ),
      { cancelText: 'Cancel', confirmText: 'Remove agent', destructive: true },
    );
    expect(client.removeAgent).toHaveBeenCalledWith(WORKSPACE, AGENT);
  });
  it('lists the grant store on the agent profile and lets the owner revoke a live rule', async () => {
    const owner = { pubkey: VIEWER, kind: 'human', name: 'Viewer' };
    const alex = { pubkey: MEMBER, kind: 'human', name: 'Builder' };
    state.agent = {
      ...baseAgent(),
      canManageGrants: true,
      grants: [
        {
          grantId: 'g-live',
          kind: 'command',
          target: 'fly deploy -a preview --with FLY_TOKEN',
          reason: 'publish the preview',
          status: 'approved',
          requestedBy: alex,
          decidedBy: owner,
          roomId: '22222222-2222-4222-8222-222222222222',
          createdAt: 1_756_900_000,
          decidedAt: 1_756_900_060,
          auto: false,
        },
        {
          grantId: 'g-denied',
          kind: 'host',
          target: 'api.fly.io',
          reason: 'reach the API',
          status: 'denied',
          requestedBy: alex,
          decidedBy: owner,
          roomId: '22222222-2222-4222-8222-222222222222',
          createdAt: 1_756_900_000,
          decidedAt: 1_756_900_061,
          auto: false,
        },
      ],
    };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    expect(renderer.root.findAllByProps({ testID: 'agent-grants-empty' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'agent-grant-g-live-line' }).props.children).toMatch(
      /^command · fly deploy -a preview --with FLY_TOKEN · always by Viewer · /,
    );
    expect(renderer.root.findByProps({ testID: 'agent-grant-g-denied-line' }).props.children).toMatch(
      /^host · api.fly.io · denied by Viewer · /,
    );
    // Only the live rule can be revoked.
    expect(renderer.root.findAllByProps({ testID: 'agent-grant-g-denied-revoke' })).toHaveLength(0);
    await press(renderer, 'agent-grant-g-live-revoke');
    expect(phoneOperation).toHaveBeenCalledWith('revokeAgentGrant', { grantId: 'g-live' });
    expect(renderer.root.findByProps({ testID: 'agent-grant-g-live-line' }).props.children).toContain(
      '· revoked by Viewer ·',
    );
    expect(renderer.root.findAllByProps({ testID: 'agent-grant-g-live-revoke' })).toHaveLength(0);
  });

  it('shows the grant list without revoke controls to a viewer the server does not authorize', async () => {
    state.agent = {
      ...baseAgent(),
      canManageGrants: false,
      grants: [
        {
          grantId: 'g-live',
          kind: 'command',
          target: 'npm test',
          reason: 'run the suite',
          status: 'approved',
          requestedBy: { pubkey: MEMBER, kind: 'human', name: 'Builder' },
          decidedBy: { pubkey: OWNER, kind: 'human', name: 'Captain' },
          roomId: '22222222-2222-4222-8222-222222222222',
          createdAt: 1_756_900_000,
          decidedAt: 1_756_900_060,
          auto: false,
        },
      ],
    };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    expect(renderer.root.findByProps({ testID: 'agent-grant-g-live-line' }).props.children).toContain(
      'npm test · always by Captain',
    );
    expect(renderer.root.findAllByProps({ testID: 'agent-grant-g-live-revoke' })).toHaveLength(0);
    expect(phoneOperation).not.toHaveBeenCalledWith('revokeAgentGrant', expect.anything());
  });

});
