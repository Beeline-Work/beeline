import * as React from 'react';
import { readFileSync } from 'node:fs';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const VIEWER = 'a'.repeat(64);
const AGENT = 'd'.repeat(64);

const route = vi.hoisted(() => ({ action: 'add-agent' as string | undefined }));
const roomView = vi.hoisted(() => ({
  workspace: vi.fn(),
  agent: vi.fn(),
}));
const share = vi.hoisted(() => vi.fn(async () => undefined));
const clipboard = vi.hoisted(() => vi.fn(async () => undefined));
const client = vi.hoisted(() => ({
  surfaceSubscribe: vi.fn(async () => vi.fn()),
  createInvite: vi.fn(async () => ({ token: `bzi_${'e'.repeat(64)}` })),
  createAgentPairingCode: vi.fn(async () => ({
    code: 'BZA_TEST_PAIRING',
    expiresAt: 2_000_000_000,
  })),
}));

vi.mock('expo-router', () => ({
  router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
  useLocalSearchParams: () => ({ communityId: WORKSPACE, action: route.action }),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard }));
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
  Typography: { mono: () => ({ fontFamily: 'mono' }), default: () => ({}) },
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
vi.mock('@/modal/ModalManager', () => ({
  Modal: { confirm: vi.fn(async () => true), prompt: vi.fn(async () => null) },
}));
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

const workspace = {
  workspace: {
    id: WORKSPACE,
    name: 'Builders',
    visibility: 'invite-only',
    role: 'owner',
    updatedAt: 1,
    createdAt: 1,
  },
  members: [{ identity: { pubkey: VIEWER, kind: 'human', name: 'Viewer' }, role: 'owner' }],
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
    role: 'owner',
    permissions: { send: true, manage: true },
  },
  watchFilters: [{ kinds: [30078], authors: [AGENT] }],
};

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
  route.action = 'add-agent';
  roomView.workspace.mockResolvedValue(workspace);
});

describe('Members agent invitation flow', () => {
  it('subscribes to the indexed agent filter after cold bootstrap so the first heartbeat clears offline', async () => {
    const renderer = await render();

    expect(renderer.root.findByProps({ testID: 'workspace-members-surface' })).toBeDefined();

    expect(client.surfaceSubscribe).toHaveBeenNthCalledWith(
      1,
      [{ kinds: [0, 9, 9000, 9001], '#h': [WORKSPACE] }],
      expect.any(Function),
    );
    expect(client.surfaceSubscribe).toHaveBeenNthCalledWith(
      2,
      workspace.watchFilters,
      expect.any(Function),
    );
  });

  it('immediately shows one install-and-pair command, with no Room picker', async () => {
    const renderer = await render();

    expect(renderer.root.findByProps({ testID: 'invite-agent-flow' })).toBeDefined();
    expect(client.createAgentPairingCode).toHaveBeenCalledWith(WORKSPACE);
    const command = renderer.root.findByProps({ testID: 'pair-agent-command' }).props.children;
    expect(command).toBe(
      'curl -fsSL https://usebeeline.app/install | sh && beeline pair BZA_TEST_PAIRING',
    );
  });

  it('honours the person-invite deep link without a second tap', async () => {
    route.action = 'invite';
    await render();

    expect(client.createInvite).toHaveBeenCalledWith(WORKSPACE);
    expect(share).toHaveBeenCalledOnce();
  });
});

describe('Members invite affordance design', () => {
  const source = readFileSync(new URL('./MembersScreen.tsx', import.meta.url), 'utf8');

  it('keeps person and agent invites as matching quiet mono controls', async () => {
    route.action = undefined;
    const renderer = await render();
    const person = renderer.root.findByProps({ testID: 'invite-person' });
    const agent = renderer.root.findByProps({ testID: 'invite-agent' });

    expect(person.props.label).toBe('INVITE PERSON');
    expect(agent.props.label).toBe('INVITE AGENT');
    expect(person.props.variant).toBe('secondary');
    expect(agent.props.variant).toBe('secondary');
    expect(person.props.labelStyle).toEqual(agent.props.labelStyle);
  });

  it('keeps permanent header and member indexes off lifted/card surfaces', () => {
    expect(source).toContain('<View style={styles.header}>');
    expect(source).not.toContain('<HullSurface strength="quiet" style={styles.header}>');
    expect(source).toMatch(/section:\s*\{\s*\}/);
    expect(source).not.toMatch(/sectionHeading:[\s\S]{0,220}backgroundColor/);
  });
});
