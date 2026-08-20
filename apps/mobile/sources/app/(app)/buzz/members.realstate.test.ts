/**
 * The Members directory, driven by state captured from the REAL relay.
 *
 * Two rounds of fixes for "People 0" and "agent OFFLINE" were reasoned from the
 * code and missed the surface. Everything below is instead the literal state of
 * the captain's Personal Workspace `6fd12761-…`, read off
 * `relay.buzzrouter.com` — the create event, the 39001/39002 projections, the
 * registered agent, and Lena's own presence record — so the test fails for the
 * same reason the device does.
 *
 * The captured facts:
 *
 *   kind 9007  h=6fd12761… community=6fd12761… name="Personal" by=51bc0809…
 *   kind 39002 p=[51bc0809…, 83843edd…]        (owner + Lena)
 *   kind 39001 p=[51bc0809…]                   (owner)
 *   listAgents(6fd12761…) -> [Lena 83843edd…]
 *   kind 30078 d=agent-presence:7f2f9a35…  h=7f2f9a35…  status=online
 *
 * So the relay holds two members, one of them a person, and a live `online`
 * heartbeat. The screen showed "People 0 — No people in this Workspace yet"
 * and Lena OFFLINE anyway.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Captured verbatim from the relay. */
const WORKSPACE = '6fd12761-33f9-442e-a562-f70158c8689d';
const OWNER = '51bc08094622e68bae676c9c82aef0f3c83897d6f8e483a58d185f5430bb39eb';
const LENA = '83843edd99dd1343cdef8a081708947d4f6a577a5a22e39d041420f6c9c7df3e';
const LENA_ROOM = '7f2f9a35-eadd-4a25-812c-25deb554448d';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const client = vi.hoisted(() => ({
  listAgents: vi.fn(),
  communityMembers: vi.fn(),
  getPersonProfile: vi.fn(async () => undefined),
  listPersonProfiles: vi.fn(async () => []),
  addMember: vi.fn(async () => undefined),
  waitUntilMemberRole: vi.fn(async () => undefined),
  removeAgent: vi.fn(async () => undefined),
  createAgentPairingCode: vi.fn(async () => ({ code: 'abc123', expiresAt: 0 })),
  createInvite: vi.fn(async () => ({ token: 'bzi_test' })),
}));
const agentPresenceBackfillForWorkspace = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const prepareWorkspace = vi.hoisted(() => vi.fn());
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
  useLocalSearchParams: () => ({ communityId: WORKSPACE }),
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
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: OWNER, secretKey: new Uint8Array(32) })),
}));
vi.mock('@/buzz/avatar-upload', () => ({ pickAndUploadAvatar: vi.fn() }));
vi.mock('@/buzz/workspace-bootstrap', () => ({ prepareWorkspaceContext: prepareWorkspace }));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => client);
    agentPresenceBackfillForWorkspace = agentPresenceBackfillForWorkspace;
    agentModelCatalogRead = vi.fn(async () => null);
    agentModelConfigRead = vi.fn(async () => null);
    agentModelConfigSet = vi.fn(async () => undefined);
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
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Alert: { alert: vi.fn() },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Share: { share: vi.fn() },
    ActivityIndicator: host('ActivityIndicator'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Switch: host('Switch'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

import { useBuzzLocalCache } from '@/buzz/local-cache';
import MembersScreen from './MembersScreen';

const originalConsoleError = console.error;
beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

const lenaAgent = {
  agentId: 'lena',
  communityId: WORKSPACE,
  displayName: 'Lena',
  pubkey: LENA,
  createdAt: 1_787_110_534,
  raw: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mmkvValues.clear();
  useBuzzLocalCache.getState().clear();
  // Exactly what the relay returns for this Workspace.
  client.listAgents.mockResolvedValue([lenaAgent]);
  client.communityMembers.mockResolvedValue([
    { pubkey: OWNER, role: 'owner' },
    { pubkey: LENA, role: 'member' },
  ]);
  prepareWorkspace.mockResolvedValue({
    workspaces: [{ communityId: WORKSPACE, name: 'Personal', viewerRole: 'owner' }],
    activeWorkspaceId: WORKSPACE,
  });
  agentPresenceBackfillForWorkspace.mockResolvedValue([]);
});

/**
 * The Workspace roster cache as `channels.tsx` writes it for this Workspace.
 *
 * It holds Lena and NO people, because `loadWorkspaceRoster` filters
 * `member.pubkey !== viewerPubkey` — right for the Rooms screen ("who ELSE is
 * here"), and the reason the owner is missing here.
 */
function warmCacheAsChannelsScreenWritesIt(): void {
  useBuzzLocalCache.getState().setActiveViewer(OWNER);
  useBuzzLocalCache.getState().setChannelList({
    viewerPubkey: OWNER,
    communityId: WORKSPACE,
    channels: [],
    directMessages: [],
    workspaceMembers: [
      { peerPubkey: LENA, peerName: 'Lena', peerKind: 'agent', peerAgent: lenaAgent },
    ],
    communities: [{ communityId: WORKSPACE, name: 'Personal', viewerRole: 'owner' }],
    personalWorkspaceId: WORKSPACE,
    viewerIsAgent: false,
    canEditWorkspaceAvatar: true,
    updatedAt: 0,
    lastAccessedAt: 0,
  } as never);
}

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(MembersScreen));
  });
  return renderer;
}

function renderedText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

/**
 * Host `Text` nodes for one person's row. The react-native mock renders each
 * host through a function component that forwards its props, so a single row
 * yields BOTH a composite and a host node with the same testID — counting raw
 * `findAllByProps` results would report every row twice.
 */
function personRows(renderer: ReactTestRenderer, pubkey: string): unknown[] {
  return renderer.root
    .findAllByType('Text')
    .filter((node: { props: { testID?: string } }) => node.props.testID === `member-${pubkey}-identity`);
}

describe('the owner of a Personal Workspace, against real captured relay state', () => {
  it('is listed once the reads land', async () => {
    warmCacheAsChannelsScreenWritesIt();
    const renderer = await render();

    expect(renderer.root.findByProps({ testID: `member-${OWNER}-identity` })).toBeDefined();
    expect(renderedText(renderer)).not.toContain('No people in this Workspace yet');
  });

  it('is listed on the very first frame, before any read resolves', async () => {
    // The screen paints from the cache with `loading` already false, so if the
    // seed says "no people" that is what the reader sees — and if the mount
    // effect then stalls (a slow relay, a WS auth that never completes) there
    // is nothing to correct it. This is the state the device was actually in.
    warmCacheAsChannelsScreenWritesIt();
    prepareWorkspace.mockImplementation(() => new Promise(() => {}));

    const renderer = await render();

    expect(renderer.root.findByProps({ testID: `member-${OWNER}-identity` })).toBeDefined();
    expect(renderedText(renderer)).not.toContain('No people in this Workspace yet');
  });

  it('is listed even with no cache at all', async () => {
    // A cold open: no roster cache, so the seed has nothing to work from and
    // only the real read can populate the section.
    useBuzzLocalCache.getState().setActiveViewer(OWNER);
    const renderer = await render();

    expect(renderer.root.findByProps({ testID: `member-${OWNER}-identity` })).toBeDefined();
  });

  it('is listed from a cache that knows no people at all, with no read landing', async () => {
    // The captain's exact state. A cache entry exists (so `loading` is false
    // and the People section really renders — this is why they saw copy rather
    // than a spinner), it holds no people because the roster it came from
    // omits the viewer, and the mount effect's reads never land to correct it.
    // Two rounds of input-level fixes could not cover this; the invariant has
    // to hold at the surface.
    warmCacheAsChannelsScreenWritesIt();
    prepareWorkspace.mockImplementation(() => new Promise(() => {}));

    const renderer = await render();
    expect(personRows(renderer, OWNER)).toHaveLength(1);
    expect(
      Number(renderer.root.findAllByType('Text').find(
        (node: { props: { testID?: string } }) => node.props.testID === 'members-people-count',
      )!.props.children),
    ).toBeGreaterThanOrEqual(1);
    expect(renderedText(renderer)).not.toContain('No people in this Workspace yet');
  });

  it('counts the owner in the People header, not just the rows', async () => {
    warmCacheAsChannelsScreenWritesIt();
    const renderer = await render();
    const count = renderer.root
      .findAllByType('Text')
      .find((node: { props: { testID?: string } }) => node.props.testID === 'members-people-count')!;
    expect(Number(count.props.children)).toBe(1);
  });

  it('never lists the viewer twice once the real read includes them', async () => {
    warmCacheAsChannelsScreenWritesIt();
    const renderer = await render();
    expect(personRows(renderer, OWNER)).toHaveLength(1);
  });

  it('does not put an agent identity in the People list', async () => {
    // Reading as Lena rather than as the owner: an agent is not a person, and
    // the surface-level invariant must not manufacture one.
    useBuzzLocalCache.getState().setActiveViewer(LENA);
    prepareWorkspace.mockImplementation(() => new Promise(() => {}));
    const renderer = await render();
    expect(personRows(renderer, LENA)).toHaveLength(0);
  });

  it('is listed even when the cache never recorded who the viewer is', async () => {
    // `activeViewerPubkey` is written by the Rooms screen. Open Members without
    // having been there this session — a deep link, the Workspace rail, a cold
    // start — and it is absent, which silently reduced the seed's viewer to
    // `undefined` and left the section empty again. The screen knows the
    // viewer from its OWN identity load; it must not depend on another
    // screen's bookkeeping to put the reader in their own Workspace.
    useBuzzLocalCache.getState().setChannelList({
      viewerPubkey: OWNER,
      communityId: WORKSPACE,
      channels: [],
      directMessages: [],
      workspaceMembers: [
        { peerPubkey: LENA, peerName: 'Lena', peerKind: 'agent', peerAgent: lenaAgent },
      ],
      communities: [{ communityId: WORKSPACE, name: 'Personal', viewerRole: 'owner' }],
      personalWorkspaceId: WORKSPACE,
      viewerIsAgent: false,
      canEditWorkspaceAvatar: true,
      updatedAt: 0,
      lastAccessedAt: 0,
    } as never);
    // Deliberately NOT setActiveViewer.
    prepareWorkspace.mockImplementation(() => new Promise(() => {}));

    const renderer = await render();
    expect(renderedText(renderer)).not.toContain('No people in this Workspace yet');
  });
});

describe('a serving agent, against its real captured presence record', () => {
  /** Lena's actual presence record, as the relay returns it. */
  function lenaOnline(ageSeconds: number): unknown {
    const createdAt = Math.floor(Date.now() / 1000) - ageSeconds;
    return {
      type: 'raw',
      sessionId: LENA_ROOM,
      payload: {
        id: 'presence-lena',
        pubkey: LENA,
        createdAt,
        content: 'online',
        tags: [
          ['d', `agent-presence:${LENA_ROOM}`],
          ['h', LENA_ROOM],
          ['t', 'agent-presence'],
          ['agent', LENA],
          ['status', 'online'],
          ['generation', 'beb114fc-569f-44b2-844f-09ccfe6ad602'],
        ],
      },
    };
  }

  it('reads ONLINE from the record the relay actually holds', async () => {
    warmCacheAsChannelsScreenWritesIt();
    agentPresenceBackfillForWorkspace.mockResolvedValue([lenaOnline(11)]);

    const renderer = await render();

    const rendered = renderedText(renderer);
    expect(agentPresenceBackfillForWorkspace).toHaveBeenCalledWith(WORKSPACE);
    expect(rendered).not.toContain('OFFLINE');
  });

  it('is not reported offline because the presence read threw', async () => {
    // The read is best-effort (`.catch(() => undefined)`), so ANY throw inside
    // it — including a `TypeError` from calling something the bundled SDK does
    // not export — is indistinguishable from "no agent is online". A mobile
    // fix that depends on a brand-new SDK symbol therefore fails silently, and
    // fails CLOSED, against a stale `dist/`: every agent reads OFFLINE.
    warmCacheAsChannelsScreenWritesIt();
    agentPresenceBackfillForWorkspace.mockRejectedValue(
      new TypeError('agentPresenceKey is not a function'),
    );

    const renderer = await render();
    // Nothing can be claimed about an agent whose presence could not be read;
    // what must never happen is the read silently deciding it is down.
    expect(agentPresenceBackfillForWorkspace).toHaveBeenCalled();
    expect(renderedText(renderer)).toContain('Lena');
  });

  it('says nothing rather than OFFLINE before presence has been read at all', async () => {
    // A stalled mount effect never reaches the presence read, and an empty
    // presence map is UNKNOWN — the same rule the Room banner already follows.
    // Asserting OFFLINE from "nobody asked yet" is how a serving daemon was
    // reported down.
    warmCacheAsChannelsScreenWritesIt();
    prepareWorkspace.mockImplementation(() => new Promise(() => {}));

    const renderer = await render();
    expect(renderedText(renderer)).not.toContain('OFFLINE');
  });

  it('says nothing rather than OFFLINE when the presence read fails', async () => {
    warmCacheAsChannelsScreenWritesIt();
    agentPresenceBackfillForWorkspace.mockRejectedValue(new Error('relay unreachable'));

    const renderer = await render();
    expect(renderedText(renderer)).not.toContain('OFFLINE');
  });

  it('reads offline only when the record is genuinely stale', async () => {
    warmCacheAsChannelsScreenWritesIt();
    agentPresenceBackfillForWorkspace.mockResolvedValue([lenaOnline(10 * 60)]);

    const renderer = await render();
    expect(renderedText(renderer)).toContain('OFFLINE');
  });
});
