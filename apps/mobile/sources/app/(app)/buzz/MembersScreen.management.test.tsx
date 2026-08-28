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
  createInvite: vi.fn(async () => ({ token: `bzi_${'e'.repeat(64)}` })),
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
}));

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
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) =>
      factory({
        buzz: {
          bgTerminal: '#000',
          bgRaised: '#111',
          bgPressed: '#222',
          textMuted: '#888',
          textPrimary: '#fff',
          border: '#333',
          chrome: '#aaa',
          danger: '#f00',
        },
      }),
  },
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
    HullSurface: host('HullSurface'),
    MonoButton: host('MonoButton'),
    PixelLoader: host('PixelLoader'),
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
  return { identity: { pubkey, kind: 'human', name }, role };
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
        identity: { pubkey: AGENT, kind: 'agent', name: 'Clara' },
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
        options: [
          { id: 'sonnet', name: 'Sonnet' },
          { id: 'opus', name: 'Opus' },
        ],
      },
      {
        id: 'effort',
        category: 'reasoning_effort',
        options: [{ id: 'low' }, { id: 'high' }],
      },
      { id: 'mode', category: 'mode', options: [{ id: 'bypassPermissions' }] },
    ],
    selected: { model: 'sonnet', effort: 'low' },
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

describe('Members workspace management', () => {
  it('creates and shares a real Workspace invite from the People section', async () => {
    const renderer = await render();
    await press(renderer, 'invite-person');

    expect(client.createInvite).toHaveBeenCalledWith(WORKSPACE);
    expect(share).toHaveBeenCalledWith({
      message: `https://relay.test/join/bzi_${'e'.repeat(64)}`,
    });
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

  it('uses the catalog pickers, filters mode, and never offers custom effort text', async () => {
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    expect(renderer.root.findAllByProps({ testID: 'model-axis-mode' })).toHaveLength(0);
    await press(renderer, 'model-axis-model');
    await press(renderer, 'model-option-model-opus');
    expect(client.setAgentModelConfig).toHaveBeenCalledWith(WORKSPACE, AGENT, { model: 'opus' });

    await press(renderer, 'model-axis-effort');
    expect(renderer.root.findAllByProps({ testID: 'model-custom-effort' })).toHaveLength(0);
    await press(renderer, 'model-option-effort-high');
    expect(client.setAgentModelConfig).toHaveBeenCalledWith(WORKSPACE, AGENT, { effort: 'high' });
  });

  it('replaces the reported zero-axis dead end with model and fixed-level effort controls', async () => {
    state.agent = { ...baseAgent(), catalog: [] };
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);

    expect(renderer.root.findByProps({ testID: 'model-catalog-missing' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'model-axis-model' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'model-axis-effort' })).toBeDefined();
    await press(renderer, 'model-axis-effort');
    expect(renderer.root.findByProps({ testID: 'model-option-effort-low' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'model-option-effort-medium' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'model-custom-effort' })).toHaveLength(0);
  });

  it('renames through setAgentSoul without replacing existing instructions', async () => {
    modal.prompt.mockResolvedValueOnce('Scout');
    const renderer = await render();
    await press(renderer, `agent-${AGENT}-identity`);
    await press(renderer, 'rename-agent');

    expect(client.setAgentSoul).toHaveBeenCalledWith(WORKSPACE, AGENT, {
      name: 'Scout',
      soul: 'Keep the tests green.',
      avatarSeed: AGENT,
    });
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
});
