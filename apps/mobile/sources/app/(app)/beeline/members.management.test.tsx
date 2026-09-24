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
const roomView = vi.hoisted(() => ({
  workspace: vi.fn(),
  agent: vi.fn(),
  workspaceMembers: vi.fn(),
}));
const share = vi.hoisted(() => vi.fn(async () => undefined));
const modal = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  prompt: vi.fn(async () => null as string | null),
}));
const client = vi.hoisted(() => ({
  resolveDirectMessage: vi.fn(async () => ({ channelId: 'dm-room' })),
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
  refreshAgentModelCatalog: vi.fn(async () => {
    const model = state.agent.selected?.model ?? 'sonnet';
    state.agent = {
      ...state.agent,
      catalog: [
        {
          id: 'model',
          category: 'model',
          currentValue: model,
          options: [{ id: 'sonnet' }, { id: 'opus' }],
        },
        {
          id: 'effort',
          category: 'reasoning_effort',
          currentValue: model === 'opus' ? 'xhigh' : 'low',
          options: model === 'opus' ? [{ id: 'medium' }, { id: 'xhigh' }] : [{ id: 'low' }],
        },
      ],
    };
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
    const agents = state.workspace.agents.filter(
      (member: any) => member.identity.pubkey !== pubkey,
    );
    state.workspace = {
      ...state.workspace,
      agents,
      agentTotal: agents.length,
      agentsTruncated: false,
    };
  }),
  removeMember: vi.fn(async (_workspaceId: string, pubkey: string) => {
    const members = state.workspace.members.filter(
      (member: any) => member.identity.pubkey !== pubkey,
    );
    state.workspace = {
      ...state.workspace,
      members,
      peopleTotal: members.length,
      membersTruncated: false,
    };
  }),
}));

const phoneOperation = vi.hoisted(() =>
  vi.fn(async (name: string, input: any) => {
    if (name === 'updateAgentAccessPolicy') {
      state.agent = { ...state.agent, access: { ...state.agent.access, policy: input.policy } };
      return;
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
  router: { back: vi.fn(), push: vi.fn(), replace: vi.fn(), navigate: vi.fn() },
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
vi.mock('react-native-gesture-handler', async () => {
  const ReactModule = await import('react');
  return {
    Swipeable: (props: any) =>
      ReactModule.createElement('Swipeable', props, props.children, props.renderRightActions?.()),
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
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});
vi.mock('@/components/buzz/MemberPickerSheet', async () => {
  const ReactModule = await import('react');
  return {
    MemberPickerSheet: (props: any) => ReactModule.createElement('MemberPickerSheet', props),
  };
});
vi.mock('@/components/buzz/HullActionSheet', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    HullActionSheetModal: (props: any) =>
      props.visible
        ? ReactModule.createElement('HullActionSheetModal', props, props.children)
        : null,
    HullActionSheetRow: host('HullActionSheetRow'),
    HullActionSheetCancel: host('HullActionSheetCancel'),
  };
});
vi.mock('@/modal/ModalManager', () => ({ Modal: modal }));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => client);
    resolveDirectMessage = client.resolveDirectMessage;
  },
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspace = roomView.workspace;
    agent = roomView.agent;
    workspaceMembers = roomView.workspaceMembers;
  },
}));
vi.mock('@beeline/buzz-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@beeline/buzz-client')>();
  class RoomViewClient {
    workspace = roomView.workspace;
    agent = roomView.agent;
    workspaceMembers = roomView.workspaceMembers;
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

import MembersScreen from './members';
import { ChevronGlyph } from '@/components/buzz/ChevronGlyph';

/**
 * The disclosure mark is a drawn shape, so it is not part of a row's copy any
 * more. `'right'` is a closed row, `'down'` an open one, and no glyph at all
 * is a row with nothing to open.
 */
function chevronDirections(node: { findAllByType(type: unknown): { props: never }[] }): string[] {
  return node
    .findAllByType(ChevronGlyph as never)
    .map((glyph: { props: { direction?: string } }) => glyph.props.direction ?? 'right');
}

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
        model: 'Sonnet',
        owner: { pubkey: VIEWER, kind: 'human', name: 'Viewer', handle: 'viewer' },
        presence: { status: 'online', observedAt: 1 },
      },
    ],
    managerSettings: { visibility: 'invite-only' },
    peopleTotal: 3,
    agentTotal: 1,
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
    agent: {
      identity: { pubkey: AGENT, kind: 'agent', name: 'Clara', handle: 'clara' },
      role: 'member',
    },
    owner: { pubkey: VIEWER, kind: 'human', name: 'Viewer', handle: 'viewer' },
    soul: { name: 'Clara', instructions: 'Keep the tests green.', avatarSeed: AGENT },
    seededSoul: 'You are a fox. You are a hustler who has already found the angle.',
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
    access: {
      policy: 'creator',
      owner: { id: VIEWER, name: 'Viewer', handle: 'viewer' },
      canChange: true,
    },
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
  roomView.workspaceMembers.mockImplementation(async () => ({
    members: state.workspace.members,
    agents: state.workspace.agents,
    peopleTotal: state.workspace.peopleTotal,
    agentTotal: state.workspace.agentTotal,
    membersTruncated: state.workspace.membersTruncated,
    agentsTruncated: state.workspace.agentsTruncated,
  }));
  modal.confirm.mockResolvedValue(true);
  modal.prompt.mockResolvedValue(null);
});

function sheet(renderer: ReactTestRenderer) {
  return renderer.root.findByType('MemberPickerSheet' as any);
}

describe('Members workspace management', () => {
  it('shows model and owner on the agent row without spending the row on presence', async () => {
    const renderer = await render();
    const agentRow = renderer.root.findByProps({ testID: `agent-${AGENT}-identity` });
    const mark = agentRow.findByType('IdentityMark' as any);
    expect(mark.props.kind).toBe('agent');
    expect(mark.props.alive).toBeFalsy();
    expect(agentRow.findAllByType('Text' as any)[1].props.children).toBe('Sonnet · by @viewer');
    expect(
      agentRow
        .findAllByType('Text' as any)
        .flatMap((node: any) => node.props.children)
        .join(' '),
    ).not.toMatch(/online|offline/i);
  });

  it('shares a real Workspace invite directly from the PEOPLE section head +', async () => {
    const renderer = await render();
    expect(sheet(renderer).props.visible).toBe(false);
    // No Room is in scope here: the sheet carries only the Workspace-level ways in.
    expect(sheet(renderer).props.candidates).toBeUndefined();
    await press(renderer, 'members-add-people');

    expect(client.createInvite).toHaveBeenCalledWith(WORKSPACE);
    expect(share).toHaveBeenCalledWith({
      message: `https://usebeeline.app/join/inv_${'e'.repeat(64)}`,
    });
    expect(sheet(renderer).props.visible).toBe(false);
    expect(renderer.root.findAllByProps({ testID: 'invite-person' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'invite-agent' })).toHaveLength(0);
  });

  it('opens the pairing sheet directly from the AGENTS section head +', async () => {
    const renderer = await render();
    expect(sheet(renderer).props.visible).toBe(false);
    await press(renderer, 'members-add-agents');
    expect(sheet(renderer).props.visible).toBe(true);
    expect(sheet(renderer).props.agentConnectOnly).toBe(true);
    expect(client.createAgentPairingCode).toHaveBeenCalledWith(WORKSPACE);
  });

  it('lets a non-manager add their own agent but not invite people', async () => {
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
    expect(renderer.root.findAllByProps({ testID: 'members-add-agents' }).length).toBeGreaterThan(
      0,
    );
    expect(renderer.root.findAllByProps({ testID: 'add-members' })).toHaveLength(0);
    expect(renderer.root.findAllByType('BrassButton' as any)).toHaveLength(0);
  });

  it('names the action and the kind on each section head +, with a 44pt hit area', async () => {
    const renderer = await render();
    const people = renderer.root.findByProps({ testID: 'members-add-people' });
    const agents = renderer.root.findByProps({ testID: 'members-add-agents' });
    expect(people.props.accessibilityLabel).toBe('Add people');
    expect(agents.props.accessibilityLabel).toBe('Add agents');
    expect(people.props.style.height).toBeGreaterThanOrEqual(44);
    expect(agents.props.style.height).toBeGreaterThanOrEqual(44);
  });

  it('shows People and Agents without a count when the server omits totals', async () => {
    const { peopleTotal: _people, agentTotal: _agents, ...legacy } = baseWorkspace();
    state.workspace = legacy;
    roomView.workspaceMembers.mockImplementation(async () => ({
      members: legacy.members,
      agents: legacy.agents,
      membersTruncated: false,
      agentsTruncated: false,
    }));
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'members-people-head' }).props.children).toBe(
      'People',
    );
    expect(renderer.root.findByProps({ testID: 'members-agents-head' }).props.children).toBe(
      'Agents',
    );
    expect(renderer.root.findByProps({ testID: `member-${MEMBER}-identity` })).toBeDefined();
    expect(renderer.root.findByProps({ testID: `agent-${AGENT}-identity` })).toBeDefined();

    await act(async () => {
      renderer.root.findByProps({ testID: 'members-search' }).props.onChangeText('Builder');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({ testID: 'members-people-head' }).props.children).toBe(
      'People',
    );
    expect(renderer.root.findByProps({ testID: `member-${MEMBER}-identity` })).toBeDefined();
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

  it('shows every handle once with role-only human and model-plus-owner agent subtitles', async () => {
    const renderer = await render();
    const agentRow = renderer.root.findByProps({ testID: `agent-${AGENT}-identity` });
    const agentTexts = agentRow
      .findAllByType('Text' as any)
      .map((node: any) => node.props.children);
    expect(agentTexts).toEqual(['@clara', 'Sonnet · by @viewer']);
    expect(chevronDirections(agentRow)).toEqual(['right']);
    expect(agentRow.findByType('IdentityMark' as any).props.alive).toBeFalsy();
    const personRow = renderer.root.findByProps({ testID: `member-${MEMBER}-identity` });
    expect(personRow.findAllByType('Text' as any).map((node: any) => node.props.children)).toEqual([
      '@builder',
      'member',
    ]);
    expect(chevronDirections(personRow)).toEqual(['right']);
    // The viewer's own row has no detail, so no chevron.
    const selfRow = renderer.root.findByProps({ testID: `member-${VIEWER}-identity` });
    expect(selfRow.props.disabled).toBe(true);
    expect(selfRow.findAllByType('Text' as any).map((node: any) => node.props.children)).toEqual([
      '@viewer',
      'owner',
    ]);
    expect(chevronDirections(selfRow)).toEqual([]);
  });

  it('shows the connected owner on the agent profile', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    expect(renderer.root.findByProps({ testID: 'agent-owner' }).props.children).toBe('by @viewer');
  });

  it('omits a handleless owner from the agent row and profile', async () => {
    const owner = { pubkey: VIEWER, kind: 'human' as const, name: 'Viewer' };
    state.workspace = {
      ...baseWorkspace(),
      agents: [{ ...baseWorkspace().agents[0], owner }],
    };
    state.agent = { ...baseAgent(), owner };
    const renderer = await render();
    const agentRow = renderer.root.findByProps({ testID: `agent-${AGENT}-identity` });
    expect(agentRow.findAllByType('Text' as any).map((node: any) => node.props.children)).toEqual([
      '@clara',
      'Sonnet',
    ]);
    expect(chevronDirections(agentRow)).toEqual(['right']);

    await press(renderer, `agent-${AGENT}-identity`);
    expect(renderer.root.findAllByProps({ testID: 'agent-owner' })).toHaveLength(0);
  });

  it('opens member actions in a sheet and confirms Workspace removal', async () => {
    const renderer = await render();
    expect(renderer.root.findAllByProps({ testID: `member-${MEMBER}-roles` })).toHaveLength(0);
    await press(renderer, `member-${MEMBER}-identity`);
    expect(renderer.root.findByProps({ testID: 'member-actions' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: `member-${MEMBER}-roles` })).toBeDefined();
    expect(
      renderer.root.findByProps({ testID: `remove-person-${MEMBER}` }).props.accessibilityLabel,
    ).toBe('Remove Builder from Workspace');
    await press(renderer, `remove-person-${MEMBER}`);

    expect(modal.confirm).toHaveBeenCalledWith(
      'Remove Builder?',
      expect.stringMatching(/every Room/),
      { cancelText: 'Cancel', confirmText: 'Remove', destructive: true },
    );
    expect(client.removeMember).toHaveBeenCalledWith(WORKSPACE, MEMBER);
    expect(renderer.root.findAllByProps({ testID: `member-${MEMBER}-identity` })).toHaveLength(0);
  });

  it('lets an admin remove a peer admin but never offers owner removal', async () => {
    state.workspace = {
      ...baseWorkspace('admin'),
      members: [
        member(VIEWER, 'Viewer', 'admin'),
        member(OWNER, 'Captain', 'owner'),
        member(MEMBER, 'Builder', 'admin'),
      ],
    };
    const renderer = await render();
    await press(renderer, `member-${OWNER}-identity`);
    expect(renderer.root.findAllByProps({ testID: `remove-person-${OWNER}` })).toHaveLength(0);
    await press(renderer, `member-${MEMBER}-identity`);
    expect(renderer.root.findAllByProps({ testID: `member-${MEMBER}-roles` })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: `remove-person-${MEMBER}` })).toBeDefined();
    await press(renderer, `remove-person-${MEMBER}`);
    expect(client.removeMember).toHaveBeenCalledWith(WORKSPACE, MEMBER);
  });

  it('offers messaging but hides role and removal controls from a non-manager', async () => {
    state.workspace = {
      ...baseWorkspace(),
      viewer: {
        ...baseWorkspace().viewer,
        role: 'member',
        permissions: { send: true, manage: false },
      },
    };
    const renderer = await render();
    await press(renderer, `member-${MEMBER}-identity`);
    expect(renderer.root.findByProps({ testID: `message-person-${MEMBER}` })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: `member-${MEMBER}-roles` })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: `remove-person-${MEMBER}` })).toHaveLength(0);
  });

  it('opens a direct message from member actions', async () => {
    const renderer = await render();
    await press(renderer, `member-${MEMBER}-identity`);
    await press(renderer, `message-person-${MEMBER}`);
    expect(client.resolveDirectMessage).toHaveBeenCalledWith(WORKSPACE, MEMBER);
    const { router } = await import('expo-router');
    expect(router.navigate).toHaveBeenCalledWith(
      { pathname: '/beeline/chat/[channelId]', params: { channelId: 'dm-room' } },
      { dangerouslySingular: true },
    );
  });

  it('shows a direct message error after dismissing the sheet', async () => {
    client.resolveDirectMessage.mockRejectedValueOnce(new Error('network unavailable'));
    const renderer = await render();
    await press(renderer, `member-${MEMBER}-identity`);
    await press(renderer, `message-person-${MEMBER}`);
    expect(renderer.root.findByProps({ testID: 'member-actions' }).props.visible).toBe(false);
    expect(renderer.root.findAllByType('Text' as any).some((node: any) =>
      String(node.props.children).includes('Could not open message: Error: network unavailable'),
    )).toBe(true);
  });

  it('keeps the member when removal confirmation is canceled', async () => {
    modal.confirm.mockResolvedValue(false);
    const renderer = await render();
    await press(renderer, `member-${MEMBER}-identity`);
    await press(renderer, `remove-person-${MEMBER}`);
    expect(modal.confirm).toHaveBeenCalledOnce();
    expect(client.removeMember).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ testID: `member-${MEMBER}-identity` })).toBeDefined();
  });

  it('lets an admin change a member role but exposes no editor for an owner', async () => {
    state.workspace = baseWorkspace('admin');
    const renderer = await render();

    await press(renderer, `member-${OWNER}-identity`);
    expect(renderer.root.findAllByProps({ testID: `member-${OWNER}-roles` })).toHaveLength(0);
    await press(renderer, `member-${MEMBER}-identity`);
    expect(renderer.root.findByProps({ testID: `member-${MEMBER}-member` }).props.selected).toBe(
      true,
    );
    expect(renderer.root.findByProps({ testID: `member-${MEMBER}-admin` }).props.selected).toBe(
      false,
    );
    expect(renderer.root.findByProps({ testID: `member-${MEMBER}-owner` }).props.disabled).toBe(
      true,
    );
    await press(renderer, `member-${MEMBER}-admin`);

    expect(client.addMember).toHaveBeenCalledWith(WORKSPACE, MEMBER, 'admin');
    expect(client.waitUntilMemberRole).toHaveBeenCalledWith(WORKSPACE, MEMBER, 'admin');
    expect(
      renderer.root
        .findByProps({ testID: `member-${MEMBER}-identity` })
        .findAllByType('Text' as any)
        .map((node: any) => node.props.children),
    ).toEqual(['@builder', 'admin']);
  });

  it('lets an owner persist a role change and reflects the selected role', async () => {
    const renderer = await render();
    await press(renderer, `member-${MEMBER}-identity`);
    expect(renderer.root.findByProps({ testID: `member-${MEMBER}-owner` }).props.disabled).toBe(
      false,
    );
    await press(renderer, `member-${MEMBER}-owner`);
    expect(client.addMember).toHaveBeenCalledWith(WORKSPACE, MEMBER, 'owner');
    expect(
      renderer.root
        .findByProps({ testID: `member-${MEMBER}-identity` })
        .findAllByType('Text' as any)
        .map((node: any) => node.props.children),
    ).toEqual(['@builder', 'owner']);
    expect(renderer.root.findAllByProps({ testID: `remove-person-${MEMBER}` })).toHaveLength(0);
  });

  it('renders MODEL and EFFORT rows with the live catalog as a typeahead chooser', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    expect(renderer.root.findAllByProps({ testID: 'model-axis-mode' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-config-activation-note' })).toHaveLength(
      0,
    );
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
    // After a model switch the row requests that model's live effort catalog.
    await press(renderer, 'model-axis-effort');
    expect(renderer.root.findAllByProps({ testID: 'model-option-effort-high' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'model-option-effort-xhigh' })).toBeDefined();
    expect(client.refreshAgentModelCatalog).toHaveBeenCalledWith(WORKSPACE, AGENT);
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

  it('shows the current selection but offers nothing without a live catalog', async () => {
    state.agent = {
      ...baseAgent(),
      catalog: [],
      selected: { model: 'openrouter/z-ai/glm-5.3-flash' },
    };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    expect(renderer.root.findAllByProps({ testID: 'model-catalog-missing' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-config-activation-note' })).toHaveLength(
      0,
    );
    expect(
      renderer.root.findByProps({ testID: 'model-axis-model' }).props.children[1].props.children,
    ).toBe('openrouter/z-ai/glm-5.3-flash');
    expect(
      renderer.root.findByProps({ testID: 'model-axis-effort' }).props.children[1].props.children,
    ).toBe('—');

    await press(renderer, 'model-axis-model');
    expect(renderer.root.findAllByProps({ testID: 'model-search-model' })).toHaveLength(0);
    expect(client.setAgentModelConfig).not.toHaveBeenCalled();
  });

  it('refreshes missing effort choices from the live catalog', async () => {
    state.agent = { ...baseAgent(), catalog: [], selected: undefined };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    await press(renderer, 'model-axis-effort');
    expect(client.refreshAgentModelCatalog).toHaveBeenCalledWith(WORKSPACE, AGENT);
    expect(renderer.root.findByProps({ testID: 'model-option-effort-low' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'model-option-effort-xhigh' })).toHaveLength(0);
  });

  it('shows an actionable effort refresh failure instead of doing nothing', async () => {
    state.agent = { ...baseAgent(), catalog: [], selected: { model: 'sonnet' } };
    client.refreshAgentModelCatalog.mockRejectedValueOnce(new Error('agent offline'));
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    await press(renderer, 'model-axis-effort');

    expect(renderer.root.findByProps({ testID: 'model-axis-error-effort' }).props.children).toBe(
      'Could not load effort choices for this model. Make sure the agent is online, then try again or choose another model.',
    );
  });

  it('marks a persisted model that failed live startup validation', async () => {
    state.agent = { ...baseAgent(), modelUnavailable: 'model' };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    expect(renderer.root.findByProps({ testID: 'model-unavailable-model' }).props.children).toBe(
      '!',
    );
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

  it('opens the soul editor on the running soul with no seeded restore control', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    await press(renderer, 'edit-agent-soul');
    // The editor opens on what the agent is actually running under.
    expect(renderer.root.findByProps({ testID: 'agent-soul-instructions' }).props.value).toBe(
      'Keep the tests green.',
    );
    // The seeded-restore control is gone; the editor carries only cancel/save.
    expect(renderer.root.findAllByProps({ testID: 'restore-seeded-soul' })).toHaveLength(0);
  });

  it('writes the seeded soul back when the owner pastes it in', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    await press(renderer, 'edit-agent-soul');
    await act(async () => {
      renderer.root
        .findByProps({ testID: 'agent-soul-instructions' })
        .props.onChangeText(state.agent.seededSoul);
    });
    await press(renderer, 'save-agent-soul');
    expect(client.setAgentSoul).toHaveBeenCalledWith(WORKSPACE, AGENT, {
      name: 'Clara',
      soul: state.agent.seededSoul,
      avatarSeed: AGENT,
    });
  });

  it('keeps the soul input on the theme text token with a themed placeholder', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    await press(renderer, 'edit-agent-soul');
    const input = renderer.root.findByProps({ testID: 'agent-soul-instructions' });
    expect(input.props.style.color).toBe(unistylesTheme.buzz.textPrimary);
    expect(input.props.placeholderTextColor).toBe(unistylesTheme.buzz.textMuted);
  });

  it('leaves agent rows inert for a member who is neither admin nor owner', async () => {
    state.workspace = {
      ...baseWorkspace(),
      viewer: {
        ...baseWorkspace().viewer,
        role: 'member',
        permissions: { send: true, manage: false },
      },
    };
    const renderer = await render();
    const row = renderer.root.findByProps({ testID: `agent-${AGENT}-identity` });
    expect(row.props.disabled).toBe(true);
    expect(row.props.onPress).toBeUndefined();
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);
    expect(
      chevronDirections(renderer.root.findByProps({ testID: `agent-${AGENT}-identity` })),
    ).toEqual([]);
  });

  it('keeps agent rows clickable with their chevron for admin and owner viewers', async () => {
    for (const role of ['admin', 'owner'] as const) {
      state.workspace = baseWorkspace(role);
      const renderer = await render();
      const row = renderer.root.findByProps({ testID: `agent-${AGENT}-identity` });
      expect(row.props.disabled).toBe(false);
      expect(typeof row.props.onPress).toBe('function');
      await press(renderer, `agent-${AGENT}-identity`);
      expect(renderer.root.findByProps({ testID: `agent-${AGENT}-model-config` })).toBeTruthy();
      expect(
        chevronDirections(renderer.root.findByProps({ testID: `agent-${AGENT}-identity` })),
      ).toEqual(['down']);
    }
  });

  it('shows the seeded soul when its owner has not written one', async () => {
    state.agent = { ...baseAgent(), soul: undefined };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    expect(renderer.root.findByProps({ testID: 'agent-soul-copy' }).props.children).toBe(
      state.agent.seededSoul,
    );
  });

  it('uses a pencil control and collapses the detail from the open row', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    expect(
      renderer.root.findByProps({ testID: 'edit-agent-soul' }).findByType('Text').props.children,
    ).toBe('✎');
    expect(renderer.root.findAllByProps({ testID: 'close-agent-settings' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'rename-agent' })).toHaveLength(0);
    await press(renderer, `agent-${AGENT}-identity`);
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);
  });

  it('lets the owner open the agent to everyone, and names who to ask until they do', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    const toggle = renderer.root.findByProps({ testID: 'agent-access-switch' });
    expect(toggle.props.disabled).toBe(false);
    expect(toggle.props.value).toBe(false);
    // The owner is named by @handle here for the same reason the Room's system
    // lines name them that way: a display name is not an address.
    expect(renderer.root.findByProps({ testID: 'agent-access-caption' }).props.children).toBe(
      'Only @viewer may ask this agent; everyone else is told to ask @viewer here. ' +
        'Only the owner can change this.',
    );

    await act(async () => {
      await toggle.props.onValueChange(true);
    });

    expect(phoneOperation).toHaveBeenCalledWith('updateAgentAccessPolicy', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      policy: 'everyone',
    });
    expect(renderer.root.findByProps({ testID: 'agent-access-switch' }).props.value).toBe(true);
    expect(renderer.root.findByProps({ testID: 'agent-access-caption' }).props.children).toBe(
      'Anyone in the Room can have Clara run commands, install software and change configuration ' +
        'on your machine. Turn this off and only you may ask them.',
    );
    expect(renderer.root.findAllByProps({ testID: 'agent-access-error' })).toHaveLength(0);
  });

  it("hides another owner's agent configuration from a plain member", async () => {
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
      access: {
        policy: 'creator',
        owner: { id: OWNER, name: 'Captain', handle: 'lunchboxfortwo' },
        canChange: false,
      },
    };
    const renderer = await render();
    // A plain member cannot open the detail panel at all: the row is inert.
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);

    expect(renderer.root.findAllByProps({ testID: 'agent-access-switch' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'edit-agent-soul' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-axis-model' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'remove-agent' })).toHaveLength(0);
  });

  it("offers an admin only the ban affordance for another owner's agent", async () => {
    state.workspace = baseWorkspace('admin');
    state.agent = {
      ...baseAgent(),
      access: {
        policy: 'creator',
        owner: { id: OWNER, name: 'Captain', handle: 'lunchboxfortwo' },
        canChange: false,
      },
      yolo: { enabled: false, canChange: false },
    };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    expect(renderer.root.findAllByProps({ testID: 'edit-agent-soul' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-axis-model' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'agent-access-switch' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'agent-yolo-switch' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'agent-handle' }).props.children).toBe('@clara');
    const ban = renderer.root.findByProps({ testID: 'remove-agent' });
    expect(ban.props.accessibilityLabel).toBe('Ban agent');
    expect(ban.findAllByType('Text')[0].props.children).toBe('Ban');
  });

  it('lets the owner flip yolo and shows who set it', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    const toggle = renderer.root.findByProps({ testID: 'agent-yolo-switch' });
    expect(toggle.props.disabled).toBe(false);
    expect(toggle.props.value).toBe(false);
    expect(toggle.props.trackColor).toEqual({ false: '#111', true: '#d7af5f' });
    expect(renderer.root.findByProps({ testID: 'agent-yolo-caption' }).props.children).toBe(
      'Clara acts without stopping to ask. Two things still ask you: anything that names one of ' +
        'your credentials, and a script nobody has read.',
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

  it('shows an owner that public Workspace policy forces yolo off', async () => {
    state.agent = {
      ...baseAgent(),
      yolo: { enabled: false, forcedOff: true, canChange: true },
    };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    expect(renderer.root.findByProps({ testID: 'agent-yolo-switch' }).props).toMatchObject({
      disabled: true,
      value: false,
    });
    expect(renderer.root.findByProps({ testID: 'agent-yolo-caption' }).props.children).toBe(
      'Yolo is forced off while this workspace is public.',
    );
  });

  it("hides another owner's yolo setting from a plain member", async () => {
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
      access: {
        policy: 'creator',
        owner: { id: OWNER, name: 'Captain', handle: 'lunchboxfortwo' },
        canChange: false,
      },
      yolo: { enabled: true, canChange: false, setBy: { name: 'Captain' }, setAt: 1_756_684_800 },
    };
    const renderer = await render();
    // A plain member cannot open the detail panel at all: the row is inert.
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);

    expect(renderer.root.findAllByProps({ testID: 'agent-yolo-switch' })).toHaveLength(0);
  });

  it('flips yolo optimistically and rolls back with the server message when refused', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    let settle!: () => void;
    const pending = new Promise<void>((resolve) => (settle = resolve));
    phoneOperation.mockImplementationOnce(async () => {
      await pending;
      throw Object.assign(new Error('Monolith updateAgentYolo failed (403)'), {
        code: "Only the agent's owner can change this",
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
      "Only the agent's owner can change this",
    );
    expect(roomView.agent).toHaveBeenCalled();
  });

  it('warns about and invokes the full removeAgent host teardown path', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    // The control sits beside the agent's handle and its owner byline.
    expect(renderer.root.findByProps({ testID: 'agent-handle' }).props.children).toBe('@clara');
    expect(renderer.root.findByProps({ testID: 'agent-owner' }).props.children).toBe('by @viewer');
    const control = renderer.root.findByProps({ testID: 'remove-agent' });
    expect(control.props.accessibilityLabel).toBe('Remove agent');
    expect(control.findAllByType('Text')[0].props.children).toBe('Remove');

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

  it('draws a removed agent nowhere: no row, no count, no open detail', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    expect(renderer.root.findByProps({ testID: 'members-agents-head' }).props.children).toEqual([
      'Agents ',
      1,
    ]);

    await press(renderer, 'remove-agent');

    // The server stops naming it, so the screen stops drawing it — the row,
    // the count, and the detail the removal was performed from.
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-identity` })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'members-agents-head' }).props.children).toEqual([
      'Agents ',
      0,
    ]);
    expect(renderer.root.findAllByProps({ testID: 'remove-agent' })).toHaveLength(0);
  });
  // The grants block was removed from this page: under yolo it read as an
  // approval queue, not the ledger it needed to be. Grants keep recording
  // server-side (agent_grants, including the auto marker) — see database.ts
  // and daemon-service.ts — but this page no longer surfaces them at all.
  it('renders no grants surface, even when the server has grants for this agent', async () => {
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
          requestedBy: { pubkey: MEMBER, kind: 'human', name: 'Builder' },
          decidedBy: { pubkey: VIEWER, kind: 'human', name: 'Viewer' },
          roomId: '22222222-2222-4222-8222-222222222222',
          createdAt: 1_756_900_000,
          decidedAt: 1_756_900_060,
          auto: true,
        },
      ],
    };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    expect(renderer.root.findAllByProps({ testID: 'agent-grants' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'agent-grants-empty' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'agent-grant-g-live-line' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'agent-grant-g-live-revoke' })).toHaveLength(0);
  });

  it('keeps the true People total, pages the first screen, searches past it, and load-more appends', async () => {
    const extras = Array.from({ length: 21 }, (_, index) =>
      member(
        `e${String(index).padStart(63, '0')}`,
        `Zebra ${String(index).padStart(2, '0')}`,
        'member',
      ),
    );
    const allPeople = [
      member(VIEWER, 'Viewer', 'owner'),
      member(OWNER, 'Captain', 'owner'),
      member(MEMBER, 'Builder', 'member'),
      ...extras,
    ];
    const firstPage = allPeople.slice(0, 20);
    const offPage = extras[20]!;
    state.workspace = {
      ...baseWorkspace(),
      members: firstPage,
      peopleTotal: allPeople.length,
      agentTotal: 1,
      membersTruncated: true,
      agentsTruncated: false,
    };
    roomView.workspaceMembers.mockImplementation(async (_workspaceId: string, query: any = {}) => {
      const needle = String(query.q ?? '')
        .trim()
        .toLowerCase();
      const filtered = needle
        ? allPeople.filter(
            (item) =>
              item.identity.name.toLowerCase().includes(needle) ||
              item.identity.handle.includes(needle),
          )
        : allPeople;
      const offset = Number(query.offset ?? 0);
      const page = filtered.slice(offset, offset + 20);
      return {
        members: query.kind === 'agent' ? [] : page,
        agents: query.kind === 'human' ? [] : state.workspace.agents,
        peopleTotal: filtered.length,
        agentTotal: needle ? 0 : 1,
        membersTruncated: offset + page.length < filtered.length,
        agentsTruncated: false,
      };
    });

    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'members-people-head' }).props.children).toEqual([
      'People ',
      allPeople.length,
    ]);
    expect(
      renderer.root.findAllByProps({ testID: `member-${firstPage[0]!.identity.pubkey}-identity` })
        .length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({ testID: `member-${offPage.identity.pubkey}-identity` }),
    ).toHaveLength(0);

    await act(async () => {
      renderer.root
        .findByProps({ testID: 'members-search' })
        .props.onChangeText(offPage.identity.name);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(roomView.workspaceMembers).toHaveBeenCalledWith(
      WORKSPACE,
      expect.objectContaining({ q: offPage.identity.name }),
    );
    expect(
      renderer.root.findAllByProps({ testID: `member-${offPage.identity.pubkey}-identity` }).length,
    ).toBeGreaterThan(0);
    expect(renderer.root.findByProps({ testID: 'members-people-head' }).props.children).toEqual([
      'People ',
      1,
    ]);

    await act(async () => {
      renderer.root.findByProps({ testID: 'members-search' }).props.onChangeText('');
      await Promise.resolve();
      await Promise.resolve();
    });
    const row = (pubkey: string) =>
      renderer.root.findAll(
        (node: any) =>
          node.type === 'TouchableOpacity' && node.props.testID === `member-${pubkey}-identity`,
      );
    const firstPageRows = firstPage.flatMap((item) => row(item.identity.pubkey)).length;
    await press(renderer, 'members-load-more-people');
    expect(roomView.workspaceMembers).toHaveBeenCalledWith(
      WORKSPACE,
      expect.objectContaining({ kind: 'human', offset: 20 }),
    );
    expect(row(offPage.identity.pubkey)).toHaveLength(1);
    expect(row(VIEWER)).toHaveLength(1);
    expect(firstPage.flatMap((item) => row(item.identity.pubkey))).toHaveLength(firstPageRows);
    expect(renderer.root.findByProps({ testID: 'members-people-head' }).props.children).toEqual([
      'People ',
      allPeople.length,
    ]);
  });
});
