
import { HumanProfile } from "../../app/(app)/beeline/human-profile";

import AgentProfileRoute from "../../app/(app)/beeline/agent-profile";

import * as React from 'react';

import { StyleSheet } from 'react-native';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';


import MembersScreen from "../../app/(app)/beeline/members";

import { router } from 'expo-router';

import { ChevronGlyph } from '@/components/buzz/ChevronGlyph';
const profileLane=vi.hoisted(()=>({mode:'legacy' as 'legacy'|'pending'|'router',view:null as any,listeners:new Set<()=>void>(),acquire:vi.fn(),query:vi.fn(),retry:vi.fn()}));
export { profileLane };




vi.mock('@/utils/responsive', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/utils/responsive')>()), useIsDesktop: () => false }));

vi.mock('@expo/vector-icons', async () => { const R = await import('react'); return { Ionicons: (props: any) => R.createElement('Ionicons', props) }; });

vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'Light' }, impactAsync: async () => undefined }));

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));


vi.mock('@/buzz/use-surface-focus', () => ({ useSurfaceFocus: () => true }));


export const WORKSPACE = '11111111-1111-4111-8111-111111111111';

export const VIEWER = 'a'.repeat(64);

export const OWNER = 'b'.repeat(64);

export const MEMBER = 'c'.repeat(64);

export const AGENT = 'd'.repeat(64);


const state = vi.hoisted(() => ({ workspace: null as any, agent: null as any }));
export { state };

const liveListeners = vi.hoisted(() => new Set<(event: any) => void>());
export { liveListeners };

vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({
  register: async (_filters: unknown, listener: (event: any) => void) => {
    liveListeners.add(listener);
    return () => liveListeners.delete(listener);
  },
}) }));

const roomView = vi.hoisted(() => ({
  workspace: vi.fn(),
  agent: vi.fn(),
  workspaceMembers: vi.fn(),
  agentVoices:vi.fn(),
}));
export { roomView };

const share = vi.hoisted(() => vi.fn(async () => undefined));
export { share };

const modal = vi.hoisted(() => ({
  confirm: vi.fn(async (_title?: string, _body?: string, _options?: { onConfirm?: () => Promise<void> }) => true),
  prompt: vi.fn(async () => null as string | null),
}));
export { modal };

const navigation = vi.hoisted(() => ({
  beforeRemove: null as null | ((event: any) => void),
  dispatch: vi.fn(),
}));
export { navigation };

const platform = vi.hoisted(() => ({ OS: 'ios' }));
export { platform };

const routeParams = vi.hoisted(() => ({
  communityId: '11111111-1111-4111-8111-111111111111',
  agentId: 'd'.repeat(64),
}));
export { routeParams };

const client = vi.hoisted(() => ({
  composeMessage: vi.fn(async (input: any, options: any) => ({
    ...input,
    options,
    id: 'avatar-request',
  })),
  publishPreparedMessage: vi.fn(async (_message: any) => undefined),
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
    state.agent = {
      ...state.agent,
      selected: { ...state.agent.selected, ...input },
      ...(typeof input.fastMode === 'boolean' ? { fastMode: input.fastMode } : {}),
    };
    return state.agent;
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
    return state.agent;
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
export { client };


const phoneOperation = vi.hoisted(() =>
  vi.fn(async (name: string, input: any): Promise<any> => {
    if (['addWorkspaceMember', 'removeWorkspaceMember'].includes(name)) return;
    if (name === 'updateAgentWake') {
      state.agent = { ...state.agent, wake: { url: input.url || null, keySet: Boolean(input.key) } };
      return state.agent;
    }
    if (name === 'updateAgentAccessPolicy') {
      state.agent = { ...state.agent, access: { ...state.agent.access, policy: input.policy } };
      return state.agent;
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
    return state.agent;
  }),
);
export { phoneOperation };

vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));


vi.mock('expo-router', () => ({
  router: { back: vi.fn(), push: vi.fn(), replace: vi.fn(), navigate: vi.fn() },
  useLocalSearchParams: () => routeParams,
  useNavigation: () => ({
    addListener: (_event: string, callback: (event: any) => void) => {
      navigation.beforeRemove = callback;
      return () => {
        navigation.beforeRemove = null;
      };
    },
    dispatch: navigation.dispatch,
  }),
}));

const safeArea = vi.hoisted(() => ({ bottom: 0 }));
export { safeArea };

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: safeArea.bottom }),
}));

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
    AccessibilityInfo: { announceForAccessibility: vi.fn() }, StyleSheet: { flatten: (style: any): any => Array.isArray(style) ? Object.assign({}, ...style.map((part: any) => Array.isArray(part) ? Object.assign({}, ...part) : part)) : style },
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Share: { share },
    Platform: platform,
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    ScrollView: host('ScrollView'),
    Switch: host('Switch'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    Pressable: host('Pressable'),
    Linking: { openURL: vi.fn(async () => undefined) },
    View: host('View'),
  };
});

const unistylesTheme = vi.hoisted(() => ({
  buzz: {
    type: {
      hero: { fontSize: 22 },
      body: { fontSize: 16 },
      meta: { fontSize: 13 },
      sectionHead: { fontSize: 10 }, sectionLabel: { fontSize: 13, lineHeight: 19, letterSpacing: 2 }, sectionCount: { fontSize: 15, lineHeight: 22 },
      machine: { fontSize: 13 },
    },
    agentProfileTypography: { name: { fontSize: 28, lineHeight: 36 } },
    space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
    transcriptCard: { identitySize: 26 },
    roomList: { edge: 20 },
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
export { unistylesTheme };

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) => factory(unistylesTheme),
  },
  useUnistyles: () => ({ theme: unistylesTheme }),
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { mono: () => ({}), default: () => ({}), ledger: () => ({}) },
}));

vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: VIEWER, secretKey: new Uint8Array(32) })),
}));

// One shared entry per address, like the app's surface registry, so every
// mounted Members instance reads and repaints the same projection.
const surfaces = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  listeners: new Map<string, Set<() => void>>(),
  observers: new Map<string, Set<(address: any, value: unknown, stamp: number) => void>>(),
}));
export { surfaces };

vi.mock('@/buzz/surface-storage', async () => {
  const { nextSurfaceStamp } = await import('@/buzz/surface-clock');
  const key = (address: any) => JSON.stringify(address);
  const write = async (address: any, value: unknown) => {
    surfaces.values.set(key(address), value);
    const stamp = nextSurfaceStamp();
    for (const observer of surfaces.observers.get(address.endpoint) ?? []) observer(address, value, stamp);
    for (const listener of surfaces.listeners.get(key(address)) ?? []) listener();
  };
  return {
    mobileSurfaceCache: {
      read: vi.fn(async (address: unknown) => surfaces.values.get(key(address)) ?? null),
      peek: vi.fn((address: unknown) => surfaces.values.get(key(address)) ?? null),
      write: vi.fn(write),
      fetch: vi.fn(async (address: unknown, _guard: unknown, request: () => Promise<unknown>) => {
        const value = await request();
        await write(address, value);
        return value;
      }),
      subscribe: vi.fn((address: unknown, listener: () => void) => {
        const listeners = surfaces.listeners.get(key(address)) ?? new Set();
        listeners.add(listener);
        surfaces.listeners.set(key(address), listeners);
        return () => listeners.delete(listener);
      }),
      observe: vi.fn((endpoint: string, observer: (address: any, value: unknown, stamp: number) => void) => {
        const observers = surfaces.observers.get(endpoint) ?? new Set();
        observers.add(observer);
        surfaces.observers.set(endpoint, observers);
        return () => observers.delete(observer);
      }),
      fenceEndpoint: vi.fn(() => nextSurfaceStamp()),
    },
    surfaceAddress: vi.fn((relayOrigin: string, viewerPubkey: string, endpoint: string, params?: unknown) => ({
      relayOrigin, viewerPubkey, endpoint, ...(params ? { params } : {}),
    })),
  };
});

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
    PixelLoader: host('PixelLoader'),
  };
});

vi.mock('@/components/buzz/Button', async () => {
  const ReactModule = await import('react');
  return { Button: (props: any) => ReactModule.createElement('Button', props, props.children) };
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
        ? ReactModule.createElement('HullActionSheetModal', props, props.sticky, props.children, props.footer)
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
    composeMessage = client.composeMessage;
    publishPreparedMessage = client.publishPreparedMessage;
  },
}));

vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspace = roomView.workspace;
    agent = roomView.agent;
    agentVoices=roomView.agentVoices;
    workspaceMembers = roomView.workspaceMembers;
  },
}));

vi.mock('@beeline/buzz-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@beeline/buzz-client')>();
  class RoomViewClient {
    workspace = roomView.workspace;
    agent = roomView.agent;
    agentVoices=roomView.agentVoices;
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


/**
 * The disclosure mark is a drawn shape, so it is not part of a row's copy any
 * more. `'right'` is a closed row, `'down'` an open one, and no glyph at all
 * is a row with nothing to open.
 */
export function chevronDirections(node: { findAllByType(type: unknown): { props: never }[] }): string[] {
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


export function member(pubkey: string, name: string, role: 'owner' | 'admin' | 'member') {
  return { identity: { pubkey, kind: 'human', name, handle: name.toLowerCase() }, role };
}


export function baseWorkspace(viewerRole: 'owner' | 'admin' = 'owner') {
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
    managerSettings: {
      visibility: 'invite-only',
      rooms: [{ id: '33333333-3333-4333-8333-333333333333', name: 'general', visibility: 'public', createdAt: 1 }],
    },
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


export function baseAgent() {
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


// Every screen unmounts before the next case, so it releases the shared
// Workspace watch and the next case opens its own.
const mounted: ReactTestRenderer[] = [];

export function create(element: React.ReactElement): ReactTestRenderer {
  const renderer = createRenderer(element);
  mounted.push(renderer);
  return renderer;
}


export async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(MembersScreen));
  });
  return renderer;
}


export async function press(renderer: ReactTestRenderer, testID: string): Promise<void> {
  await act(async () => {
    const row = renderer.root.findByProps({ testID });
    await row.props.onPress(row.props.pubkey);
  });
}


export async function agentChanged(): Promise<void> {
  await act(async () => {
    for (const listener of liveListeners) listener({ monolithLive: {
      type: 'resource-change', roomId: '', resource: 'agent', resourceId: AGENT,
    } });
    await Promise.resolve();
  });
}


export async function openAgentProfile(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.update(<MembersScreen profileAgentId={AGENT} workspaceIdOverride={WORKSPACE} />);
  });
}


export async function openAgentManagement(renderer: ReactTestRenderer): Promise<void> {
  await openAgentProfile(renderer);
  if (state.agent.access?.owner?.id === VIEWER) await press(renderer, 'edit-agent-soul');
}


beforeEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
  liveListeners.clear();
  surfaces.values.clear();
  surfaces.listeners.clear();
  vi.clearAllMocks();
  profileLane.mode='legacy';profileLane.view=null;profileLane.listeners.clear();
  profileLane.acquire.mockImplementation(()=>({current:()=>profileLane.view,release:()=>{},subscribe:(wake:()=>void)=>{profileLane.listeners.add(wake);return()=>profileLane.listeners.delete(wake);}}));
  platform.OS = 'ios';
  navigation.beforeRemove = null;
  state.workspace = baseWorkspace();
  state.agent = baseAgent();
  roomView.workspace.mockImplementation(async () => state.workspace);
  roomView.agent.mockImplementation(async () => state.agent);
  roomView.agentVoices.mockResolvedValue({currentVoiceId:'voice-1',canChange:true,choices:[{id:'voice-1',name:'Voice one'}]});
  roomView.workspaceMembers.mockImplementation(async () => ({
    viewer: state.workspace.viewer,
    members: state.workspace.members,
    agents: state.workspace.agents,
    grants: [
      {
        grantId: 'member-grant',
        kind: 'repository',
        target: 'beeline-work/beeline',
        reason: 'ship the profile pass',
        status: 'approved',
        requestedBy: { pubkey: MEMBER, kind: 'human', name: 'Builder' },
        decidedBy: { pubkey: VIEWER, kind: 'human', name: 'Viewer' },
        roomId: '22222222-2222-4222-8222-222222222222',
        roomName: 'ship-the-slab',
        createdAt: 1_756_900_000,
        decidedAt: 1_756_900_060,
        auto: false,
        agent: { pubkey: AGENT, kind: 'agent', name: 'Clara', handle: 'clara' },
      },
    ],
    peopleTotal: state.workspace.peopleTotal,
    agentTotal: state.workspace.agentTotal,
    membersTruncated: state.workspace.membersTruncated,
    agentsTruncated: state.workspace.agentsTruncated,
  }));
  client.resolveDirectMessage.mockReset().mockResolvedValue({ channelId: 'dm-room' });
  modal.confirm.mockImplementation(async (_title?: string, _body?: string, options?: { onConfirm?: () => Promise<void> }) => { await options?.onConfirm?.(); return true; });
  modal.prompt.mockResolvedValue(null);
});


export function sheet(renderer: ReactTestRenderer) {
  return renderer.root.findByType('MemberPickerSheet' as any);
}
export function fixtureScope1() {


  async function personProfile(memberId = MEMBER) {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <HumanProfile workspaceId={WORKSPACE} memberId={memberId} onClose={vi.fn()} />,
      );
    });
    return renderer;
  }
return {
personProfile,
};
}
export function fixtureScope2(scope1: ReturnType<typeof fixtureScope1>, toggle: string, operation: string) {

return {
toggle,
operation,
};
}
