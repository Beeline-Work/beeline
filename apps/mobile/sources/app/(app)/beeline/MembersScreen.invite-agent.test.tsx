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
  createInvite: vi.fn(async () => ({ token: `inv_${'e'.repeat(64)}` })),
  createAgentPairingCode: vi.fn(async () => ({
    code: '1234ABCD-5678EF90',
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
    Switch: host('Switch'),
    Text: host('Text'),
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
  watchFilters: [{ kinds: [30078], authors: [AGENT], '#t': ['agent-presence'] }],
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
  it('refreshes its subscription to server-authored agent presence filters after bootstrap', async () => {
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

  it('mints a fresh code and hands the exact one-command connect flow to the one picker sheet', async () => {
    const renderer = await render();

    const sheet = renderer.root.findByType('MemberPickerSheet' as any);
    expect(sheet.props.visible).toBe(true);
    expect(client.createAgentPairingCode).toHaveBeenCalledWith(WORKSPACE);
    expect(sheet.props.pairCommand).toBe('npx usebeeline connect 1234ABCD-5678EF90');
    await act(async () => {
      await sheet.props.onCopyPairCommand(sheet.props.pairCommand);
    });
    expect(clipboard).toHaveBeenCalledWith('npx usebeeline connect 1234ABCD-5678EF90');
    // Closing the sheet forgets the code: the next open mints a fresh one.
    await act(async () => {
      sheet.props.onClose();
    });
    const closed = renderer.root.findByType('MemberPickerSheet' as any);
    expect(closed.props.visible).toBe(false);
    expect(closed.props.pairCommand).toBeNull();
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

  it('offers one brass primary, sentence case, in place of the boxed mono invite pair (C79)', async () => {
    route.action = undefined;
    const renderer = await render();
    const brass = renderer.root.findAllByType('BrassButton' as any);
    expect(brass).toHaveLength(1);
    expect(brass[0].props.testID).toBe('add-members');
    expect(brass[0].props.label).toBe('Add people or agents');
    expect(renderer.root.findAllByProps({ testID: 'invite-person' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'invite-agent' })).toHaveLength(0);
    expect(renderer.root.findAllByType('MonoButton' as any)).toHaveLength(0);
    // Every size on the page comes from the type roles; the glyph is gone.
    expect(source).not.toMatch(/fontSize:\s*\d/);
    expect(source).not.toContain('MEMBERS_GLYPH');
  });

  it('keeps permanent header and member indexes off lifted/card surfaces', () => {
    expect(source).toContain('<View style={styles.header}>');
    expect(source).not.toContain('<HullSurface strength="quiet" style={styles.header}>');
    expect(source).toMatch(/section:\s*\{\s*\}/);
    expect(source).not.toMatch(/sectionHeading:[\s\S]{0,220}backgroundColor/);
  });
});
