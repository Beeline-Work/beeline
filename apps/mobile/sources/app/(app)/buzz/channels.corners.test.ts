/**
 * The room-list per-Room corner dropdown: behavior contract.
 *
 * From the Rooms index, a Room with open corner(s) must expose a control that
 * expands that room's corners inline, and tapping one must navigate into it.
 * A Room whose corners are all terminal (landed, failed, closed) keeps the
 * control and its All Corners path. A Room with no corners shows no control
 * at all (no dead tap).
 *
 * These are render assertions on the real screen, not source greps, because
 * what they lock is what a person can actually do from the list.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceSnapshot,
  reduceWorkspaceEvents,
  type CornerMachineState,
  type ReadEvent,
} from '@beeline/buzz-client';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const mmkvValues = vi.hoisted(() => new Map<string, string>());
const workspaceContext = vi.hoisted(() => ({
  current: {
    workspaces: [] as unknown[],
    activeWorkspaceId: null as string | null,
    personalWorkspaceId: null as string | null,
  },
}));

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
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
  openBrowserAsync: vi.fn(),
}));
vi.mock('expo-linking', () => ({ createURL: (path: string) => `beeline://${path}` }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => undefined }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  DEFAULT_RELAY_URL: 'https://relay.test',
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32),
  })),
}));
vi.mock('@/buzz/workspace-bootstrap', () => ({
  prepareWorkspaceContext: vi.fn(async () => workspaceContext.current),
}));
vi.mock('@/buzz/person-name', () => ({
  ensurePersonNameForWorkspace: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/community-invite', () => ({ createCommunityInviteUrl: vi.fn(async () => 'x') }));
vi.mock('@/buzz/local-cache-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/buzz/local-cache-sync')>();
  return {
    ...actual,
    cacheLiveSessionEvents: vi.fn(),
  };
});
vi.mock('@/buzz/defer-interaction', () => ({ afterInteractions: () => () => undefined }));

/** Corner summaries seeded into the persisted snapshot, keyed by parent Room. */
const cornerFixtures: Record<string, Array<{ id: string; name: string; status: string }>> = {};

/** What the transport's read-model backfill answers for the refresh pass.
 * Defaults to a cornerless empty snapshot; individual tests point it at a
 * thrown failure or a populated snapshot to exercise each refresh outcome
 * through the REAL projection boundary (revalidateCachedMessages + merge +
 * persist), never around it. */
const backfillBehavior: {
  mode: 'empty' | 'throw' | 'snapshot';
  snapshot?: unknown;
} = { mode: 'empty' };

vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => ({
      isAgentIdentity: vi.fn(async () => false),
      getPersonProfile: vi.fn(async () => null),
      listPersonProfiles: vi.fn(async () => []),
      listMyChannels: vi.fn(async () => [{ channelId: 'room-1' }]),
      communityMembers: vi.fn(async () => []),
      listAgents: vi.fn(async () => []),
      query: vi.fn(async (filters: any) => {
        const f = Array.isArray(filters) ? filters[0] : filters;
        if (f?.kinds?.[0] === 9007)
          return [
            {
              id: 'create-room-1',
              kind: 9007,
              created_at: 1_000,
              tags: [
                ['h', 'room-1'],
                ['community', 'shared-1'],
                ['name', 'Ledger rewrite'],
              ],
            },
          ];
        return [];
      }),
      listMembers: vi.fn(async () => [{ pubkey: VIEWER }]),
      getChannelMetadata: vi.fn(async (id: string) =>
        id === 'room-1'
          ? { name: 'Ledger rewrite', archived: false, raw: { created_at: 1_000 } }
          : null,
      ),
    }));
    roomRepositoryState = vi.fn(async () => ({ kind: 'none' }) as never);
    readModelBackfill = async () => {
      if (backfillBehavior.mode === 'throw')
        throw backfillBehavior.snapshot ?? new Error('relay unreachable');
      if (backfillBehavior.mode === 'snapshot') {
        return { snapshot: backfillBehavior.snapshot, events: [] } as never;
      }
      return {
        snapshot: createWorkspaceSnapshot({ workspaceId: 'shared-1', identities: [] }),
        events: [],
      } as never;
    };
  },
}));
vi.mock('@/components/buzz/CommunityRail', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    BuzzCommunityShell: host('BuzzCommunityShell'),
    CommunityDrawerTrigger: host('CommunityDrawerTrigger'),
  };
});
vi.mock('@/components/buzz/CommunityInviteEntry', async () => {
  const ReactModule = await import('react');
  return {
    CommunityInviteEntry: (props: any) => ReactModule.createElement('CommunityInviteEntry', props),
  };
});
vi.mock('@/components/buzz/RepoPicker', async () => {
  const ReactModule = await import('react');
  return { RepoPicker: (props: any) => ReactModule.createElement('RepoPicker', props) };
});
vi.mock('@/components/buzz/RoomDeckComposeMenu', async () => {
  const ReactModule = await import('react');
  return {
    RoomDeckComposeMenu: (props: any) => ReactModule.createElement('RoomDeckComposeMenu', props),
  };
});
vi.mock('@/components/buzz/DirectMessagePickerSheet', async () => {
  const ReactModule = await import('react');
  return {
    DirectMessagePickerSheet: (props: any) =>
      ReactModule.createElement('DirectMessagePickerSheet', props),
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
    hairlineDivider: { borderBottomWidth: 1, borderBottomColor: '#4e4e4e' },
    motionTokens: { liveCycle: 1120, reveal: 176, demoteDip: 90 },
    BrittlePress: (props: any) =>
      ReactModule.createElement(
        'BrittlePress',
        props,
        typeof props.children === 'function' ? props.children(false) : props.children,
      ),
    HullLivePulse: host('HullLivePulse'),
    HullSurface: host('HullSurface'),
    HullWaveSignal: host('HullWaveSignal'),
    HullDeckMark: host('HullDeckMark'),
    CornerGlyph: (props: any) => host('CornerGlyph')(props),
    MonoButton: host('MonoButton'),
    PixelGateReveal: host('PixelGateReveal'),
    PixelLoader: host('PixelLoader'),
  };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  const FlatList = (props: any) =>
    ReactModule.createElement('FlatList', props, [
      props.ListHeaderComponent ?? null,
      ...(props.data ?? []).map((item: unknown, index: number) =>
        ReactModule.createElement(
          ReactModule.Fragment,
          { key: props.keyExtractor(item, index) },
          props.renderItem({ item, index }),
        ),
      ),
      (props.data ?? []).length === 0 ? (props.ListEmptyComponent ?? null) : null,
      props.ListFooterComponent ?? null,
    ]);
  const SectionList = (props: any) => {
    const sections = props.sections ?? [];
    const rows = sections.flatMap((section: any) => [
      ReactModule.createElement(
        ReactModule.Fragment,
        { key: `header-${section.zone}` },
        props.renderSectionHeader?.({ section }) ?? null,
      ),
      ...section.data.map((item: unknown, index: number) =>
        ReactModule.createElement(
          ReactModule.Fragment,
          { key: props.keyExtractor(item, index) },
          props.renderItem({ item, index, section }),
        ),
      ),
    ]);
    return ReactModule.createElement('SectionList', props, [
      props.ListHeaderComponent ?? null,
      ...rows,
      rows.length === 0 ? (props.ListEmptyComponent ?? null) : null,
      props.ListFooterComponent ?? null,
    ]);
  };
  return {
    FlatList,
    SectionList,
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
    RefreshControl: host('RefreshControl'),
    Share: { share: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { useBuzzLocalCache } = await import('@/buzz/local-cache');
const { default: BuzzChannels } = await import('./channels');

const VIEWER = 'a'.repeat(64);

function corner(id: string, name: string, status: string) {
  const machine =
    status === 'live'
      ? { machineState: 'working' }
      : status === 'open'
        ? { machineState: 'waiting', machineReason: 'review' }
        : status === 'needs-attention'
          ? { machineState: 'waiting', machineReason: 'question' }
          : status === 'failed'
            ? { machineState: 'waiting', machineReason: 'failure' }
            : status === 'merged'
              ? { machineState: 'concluded' }
              : { machineState: 'closed' };
  return {
    id: id.padEnd(64, '0'),
    name,
    openerPubkey: 'agent',
    status,
    ...machine,
    stateAt: Math.floor(Date.now() / 1_000),
  };
}

function seedWorkspace() {
  const now = Date.now();
  workspaceContext.current = {
    workspaces: [{ communityId: 'shared-1', name: 'Night Shift', viewerRole: 'owner' }],
    activeWorkspaceId: 'shared-1',
    personalWorkspaceId: 'personal-1',
  };
  useBuzzLocalCache.getState().setChannelList({
    viewerPubkey: VIEWER,
    communityId: 'shared-1',
    channels: [
      {
        id: 'room-1',
        channelId: 'room-1',
        active: true,
        title: 'Ledger rewrite',
        createdAt: 1_000,
        updatedAt: 2_000,
        latestMessage: 'beebee: pushed the branch',
        latestMessageAt: 2_000,
      },
    ],
    directMessages: [],
    workspaceMembers: [],
    communities: [{ communityId: 'shared-1', name: 'Night Shift' } as never],
    personalWorkspaceId: 'personal-1',
    viewerIsAgent: false,
    canEditWorkspaceAvatar: true,
    updatedAt: now,
    lastAccessedAt: now,
  });
  const lifecycle = cornerLifecycleEvents(cornerFixtures['room-1'] ?? []);
  const snapshot = reduceWorkspaceEvents(
    createWorkspaceSnapshot({
      workspaceId: 'shared-1',
      identities: [
        { kind: 'human', pubkey: VIEWER, displayName: 'Captain', revision: '1' } as never,
      ],
    }),
    lifecycle,
  );
  useBuzzLocalCache.getState().replaceSnapshot(VIEWER, 'room-1', snapshot, undefined);
  routeParams.current = { communityId: 'shared-1' };
}

function cornerLifecycleEvents(
  entries: Array<{ id: string; name: string; status: string }>,
  generation = 0,
): ReadEvent[] {
  return entries.flatMap((item, index) => {
    const sequence = generation * 100 + index * 2;
    const state: CornerMachineState =
      item.status === 'live'
        ? 'working'
        : item.status === 'merged'
          ? 'concluded'
          : item.status === 'archived'
            ? 'closed'
            : 'waiting';
    const open = {
      type: 'lifecycle',
      eventId: `corner-open-${generation}-${index}`,
      authorPubkey: 'agent',
      createdAt: sequence + 1,
      sourceKind: 30078,
      signature: 'verified',
      scope: 'channel',
      channelId: 'room-1',
      workspaceId: 'shared-1',
      lifecycle: {
        entity: 'corner',
        cornerId: item.id,
        parentRoomId: 'room-1',
        state: 'open',
        name: item.name,
        exists: true,
        stateAt: sequence + 1,
        initialMembers: [{ pubkey: VIEWER, role: 'owner' }],
      },
    } as unknown as ReadEvent;
    if (state === 'open') return [open];
    return [
      open,
      {
        ...open,
        eventId: `corner-state-${generation}-${index}`,
        createdAt: sequence + 2,
        lifecycle: {
          ...open.lifecycle,
          state,
          stateAt: sequence + 2,
        },
      } as unknown as ReadEvent,
    ];
  });
}

async function render(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(BuzzChannels));
  });
  return tree;
}

function findAllByTestId(tree: ReactTestRenderer, testID: string) {
  return tree.root.findAll(
    (node: any) => typeof node.type === 'string' && node.props?.testID === testID,
    { deep: true },
  );
}

function findByAclPrefix(tree: ReactTestRenderer, prefix: string) {
  return tree.root.findAll(
    (node: any) =>
      typeof node.type === 'string' &&
      typeof node.props?.onPress === 'function' &&
      typeof node.props?.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith(prefix),
    { deep: true },
  );
}

async function press(node: any) {
  await act(async () => {
    node.props.onPress?.();
  });
}

describe('room-list corner dropdown', () => {
  beforeEach(() => {
    mmkvValues.clear();
    navigation.push.mockClear();
    for (const key of Object.keys(cornerFixtures)) delete cornerFixtures[key];
    backfillBehavior.mode = 'empty';
    delete backfillBehavior.snapshot;
    useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
  });

  it('a Room with N open corners expands to exactly N navigable entries', async () => {
    cornerFixtures['room-1'] = [
      corner('corner-a', 'fix ledger drift', 'live'),
      corner('corner-b', 'polish bylines', 'open'),
    ];
    seedWorkspace();
    const tree = await render();

    // The control exists and reports the open work.
    const toggle = findAllByTestId(tree, 'room-corners-toggle-room-1');
    expect(toggle).toHaveLength(1);

    await press(toggle[0]);

    // N corners -> exactly N rows, each navigating into that corner with its
    // parent Room carried for the back lookup.
    for (const [name, id] of [
      ['fix ledger drift', 'corner-a'],
      ['polish bylines', 'corner-b'],
    ] as const) {
      const row = findByAclPrefix(tree, `Open ${name} corner`);
      expect(row, `missing dropdown row for ${name}`).toHaveLength(1);
      await press(row[0]);
      expect(navigation.push).toHaveBeenCalledTimes(1);
      const pushed = navigation.push.mock.calls[0][0];
      expect(String(pushed?.params?.channelId ?? '')).toBe(id.padEnd(64, '0'));
      expect(pushed?.params?.parent).toBe('room-1');
      expect(pushed?.params?.returnTo).toBe('room-list');
      navigation.push.mockClear();
    }

    // The expansion IS the full list: no trailing All Corners row exists.
    expect(findAllByTestId(tree, 'room-all-corners-room-1')).toHaveLength(0);
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('a Room whose corners are all immutably terminal shows no corner affordance at all', async () => {
    cornerFixtures['room-1'] = [
      corner('corner-c', 'landed work', 'merged'),
      corner('corner-d', 'closed work', 'archived'),
    ];
    seedWorkspace();
    const tree = await render();

    // Finished corners are represented NOWHERE in navigation (owner's model):
    // no count, no expansion control, no rows. Their history stays reachable
    // through the transcript's landed/closed references only.
    expect(findAllByTestId(tree, 'room-corners-toggle-room-1')).toHaveLength(0);
    expect(findAllByTestId(tree, 'room-all-corners-room-1')).toHaveLength(0);
  });

  it('a Room with no corners shows no dropdown control at all', async () => {
    cornerFixtures['room-1'] = [];
    seedWorkspace();
    const tree = await render();

    expect(findAllByTestId(tree, 'room-corners-toggle-room-1')).toHaveLength(0);
    expect(findAllByTestId(tree, 'room-all-corners-room-1')).toHaveLength(0);
  });

  // The refresh pass owns corner discovery. These cases walk the REAL
  // projection boundary — revalidateCachedMessages → transport backfill →
  // snapshot merge → persisted cache → deck render — for each outcome a
  // flaky relay can produce.
  it('a failed lifecycle revalidation never wipes the persisted corners', async () => {
    cornerFixtures['room-1'] = [corner('corner-a', 'fix ledger drift', 'live')];
    seedWorkspace();
    backfillBehavior.mode = 'throw';
    const tree = await render();

    // A thrown read is not an authoritative empty answer: the previously
    // non-empty persisted corner cache must still drive the deck.
    expect(findAllByTestId(tree, 'room-corners-toggle-room-1')).toHaveLength(1);
  });

  it('an incomplete lifecycle page that looks empty never wipes the persisted corners', async () => {
    cornerFixtures['room-1'] = [corner('corner-a', 'fix ledger drift', 'live')];
    seedWorkspace();
    const tree = await render();

    // The normalized refresh merges journals, so absence from one bounded
    // page is unknown rather than proof that an earlier corner disappeared.
    expect(findAllByTestId(tree, 'room-corners-toggle-room-1')).toHaveLength(1);
  });

  it('an explicit terminal lifecycle update removes a persisted corner from the active deck', async () => {
    cornerFixtures['room-1'] = [corner('corner-a', 'fix ledger drift', 'live')];
    seedWorkspace();
    backfillBehavior.mode = 'snapshot';
    backfillBehavior.snapshot = reduceWorkspaceEvents(
      createWorkspaceSnapshot({ workspaceId: 'shared-1', identities: [] }),
      cornerLifecycleEvents([corner('corner-a', 'fix ledger drift', 'archived')], 1),
    );
    const tree = await render();

    // A verified terminal fact is authoritative. Preserving the cache on an
    // empty/failed page must not resurrect a corner after its close arrives.
    expect(findAllByTestId(tree, 'room-corners-toggle-room-1')).toHaveLength(0);
  });

  it('corners discovered by a fresh backfill reach the deck', async () => {
    // No persisted snapshot: discovery must come from this refresh's read.
    const entries = [corner('corner-e', 'freshly discovered', 'needs-attention')];
    seedWorkspace();
    useBuzzLocalCache
      .getState()
      .replaceSnapshot(
        VIEWER,
        'room-1',
        createWorkspaceSnapshot({ workspaceId: 'shared-1', identities: [] }),
        undefined,
      );
    backfillBehavior.mode = 'snapshot';
    backfillBehavior.snapshot = reduceWorkspaceEvents(
      createWorkspaceSnapshot({
        workspaceId: 'shared-1',
        identities: [
          { kind: 'human', pubkey: VIEWER, displayName: 'Captain', revision: '1' } as never,
        ],
      }),
      cornerLifecycleEvents(entries),
    );
    const tree = await render();

    expect(findAllByTestId(tree, 'room-corners-toggle-room-1')).toHaveLength(1);
  });
});
