/**
 * One home surface, whatever the Workspace is.
 *
 * A Personal Workspace and a shared Workspace are the same product surface —
 * the Rooms index — and must render through the same screen, with the same
 * vocabulary (Room/Rooms, never Channel/Channels) and the same affordances
 * (`＋ ROOM`, `⌬ MEMBERS`, per-Room previews). The only thing Personal is
 * allowed to differ on is a personal-specific affordance: there is nobody to
 * invite into your own Workspace.
 *
 * These are render assertions on the real screen, not source greps, because
 * what they lock is *what a person actually sees* on each Workspace kind.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/buzz/local-cache-sync', () => ({
  cacheLiveSessionEvents: vi.fn(),
  revalidateCachedMessages: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/defer-interaction', () => ({ afterInteractions: () => () => undefined }));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => ({
      isAgentIdentity: vi.fn(async () => false),
      getPersonProfile: vi.fn(async () => null),
      listMyChannels: vi.fn(async () => []),
    }));
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
vi.mock('@/components/buzz/HullDialog', async () => {
  const ReactModule = await import('react');
  return {
    HullDialog: (props: any) =>
      props.visible ? ReactModule.createElement('HullDialog', props, props.children) : null,
    HullDialogInput: (props: any) => ReactModule.createElement('HullDialogInput', props),
  };
});
vi.mock('@/modal', () => ({
  Modal: { alert: vi.fn(), confirm: vi.fn(async () => false) },
}));
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
    HullDeckMark: (props: any) => ReactModule.createElement('HullDeckMark', props),
    HullLivePulse: host('HullLivePulse'),
    HullSurface: host('HullSurface'),
    HullWaveSignal: host('HullWaveSignal'),
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
    ScrollView: host('ScrollView'),
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

const { channelListCacheKey, useBuzzLocalCache } = await import('@/buzz/local-cache');
const { default: BuzzChannels } = await import('./channels');

const VIEWER = 'a'.repeat(64);

function room(id: string, title: string, preview: string) {
  return {
    id,
    channelId: id,
    active: true,
    title,
    createdAt: 1_000,
    updatedAt: 2_000,
    latestMessage: preview,
    latestMessageAt: 2_000,
    corners: [],
  };
}

function seedWorkspace(communityId: string, name: string, personalWorkspaceId: string | null) {
  const now = Date.now();
  workspaceContext.current = {
    workspaces: [{ communityId, name, viewerRole: 'owner' }],
    activeWorkspaceId: communityId,
    personalWorkspaceId,
  };
  useBuzzLocalCache.getState().setChannelList({
    viewerPubkey: VIEWER,
    communityId,
    channels: [
      room('room-1', 'Ledger rewrite', 'beebee: pushed the branch'),
      room('room-2', 'Design sweep', 'you: looks good'),
    ],
    directMessages: [],
    workspaceMembers: [],
    communities: [{ communityId, name } as never],
    personalWorkspaceId,
    viewerIsAgent: false,
    canEditWorkspaceAvatar: true,
    updatedAt: now,
    lastAccessedAt: now,
  });
  routeParams.current = { communityId };
}

async function render(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(BuzzChannels));
  });
  return tree;
}

/** Every string this tree actually puts in front of a person, including the
 * labels a screen reader speaks. */
function visibleText(tree: ReactTestRenderer): string[] {
  const out: string[] = [];
  const collect = (instance: any) => {
    for (const key of ['accessibilityLabel', 'placeholder']) {
      const value = instance.props?.[key];
      if (typeof value === 'string') out.push(value);
    }
    for (const child of instance.children ?? []) {
      if (typeof child === 'string') out.push(child);
      else collect(child);
    }
  };
  collect(tree.root);
  return out;
}

function has(tree: ReactTestRenderer, testID: string): boolean {
  return (
    tree.root.findAll(
      (node: any) => typeof node.type === 'string' && node.props?.testID === testID,
      { deep: true },
    ).length > 0
  );
}

function hostByTestID(tree: ReactTestRenderer, testID: string) {
  return tree.root.findAll(
    (node: any) => typeof node.type === 'string' && node.props?.testID === testID,
    { deep: true },
  )[0];
}

const HOME_SURFACE_IDS = ['room-list', 'workspace-members', 'create-room'];

describe('one home surface for every Workspace kind', () => {
  beforeEach(() => {
    mmkvValues.clear();
    navigation.push.mockClear();
    useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
  });

  it('renders the unified Rooms home in a Personal Workspace', async () => {
    seedWorkspace('personal-1', 'Personal', 'personal-1');
    const tree = await render();

    for (const id of HOME_SURFACE_IDS) {
      expect(has(tree, id), `Personal home is missing ${id}`).toBe(true);
    }
    const text = visibleText(tree).join('');
    // Rooms index vocabulary and per-Room previews — not a bare "# name" list.
    expect(text).not.toContain("DOESN'T NEED YOU ·");
    expect(text).toContain('Ledger rewrite');
    expect(text).toContain('beebee: pushed the branch');
    expect(text).toContain('＋ ROOM');
    expect(text).toContain('MEMBERS');
  });

  it('renders the identical surface in a shared Workspace', async () => {
    seedWorkspace('shared-1', 'Night Shift', 'personal-1');
    const tree = await render();

    for (const id of HOME_SURFACE_IDS) {
      expect(has(tree, id), `shared home is missing ${id}`).toBe(true);
    }
    const text = visibleText(tree).join('');
    expect(text).not.toContain("DOESN'T NEED YOU ·");
    expect(text).toContain('＋ ROOM');
    expect(text).toContain('MEMBERS');
  });

  it('never says Channel or Channels anywhere on the home surface', async () => {
    for (const [id, name, personal] of [
      ['personal-1', 'Personal', 'personal-1'],
      ['shared-1', 'Night Shift', 'personal-1'],
    ] as const) {
      seedWorkspace(id, name, personal);
      const tree = await render();
      for (const line of visibleText(tree)) {
        expect(line, `retired vocabulary on the ${name} home: ${line}`).not.toMatch(/channels?/i);
      }
    }
  });

  it('keeps the one personal-specific affordance: no people to invite', async () => {
    const inviteProps = async (communityId: string, personal: string) => {
      seedWorkspace(communityId, 'W', personal);
      useBuzzLocalCache.getState().patchChannelList(VIEWER, communityId, { channels: [] });
      const tree = await render();
      const entry = tree.root.findAll(
        (node: any) => typeof node.type === 'string' && node.type === 'CommunityInviteEntry',
        { deep: true },
      );
      expect(entry).toHaveLength(1);
      return entry[0].props;
    };

    expect((await inviteProps('personal-1', 'personal-1')).allowPeopleInvites).toBe(false);
    expect((await inviteProps('shared-1', 'personal-1')).allowPeopleInvites).toBe(true);
  });

  it('opens New Room as a Hull input dialog with empty-name gating and both dismissal paths', async () => {
    seedWorkspace('shared-1', 'Night Shift', 'personal-1');
    const tree = await render();

    await act(async () => hostByTestID(tree, 'create-room').props.onPress());
    let dialog = tree.root.findByType('HullDialog' as any);
    expect(dialog.props).toMatchObject({
      body: 'In Night Shift. One Room, one repo. Corners branch from here.',
      testID: 'new-room-dialog',
      title: 'New Room',
      visible: true,
    });
    expect(dialog.props.actions[1]).toMatchObject({
      disabled: true,
      label: 'Create',
      testID: 'new-room-create',
      variant: 'primary',
    });
    const input = tree.root.findByType('HullDialogInput' as any);
    expect(input.props).toMatchObject({
      accessibilityLabel: 'Room name',
      editable: true,
      placeholder: '#room-name',
      testID: 'new-room-input',
    });
    expect(hostByTestID(tree, 'create-room-repo-row')).toBeDefined();

    await act(async () => input.props.onChangeText('launch-room'));
    dialog = tree.root.findByType('HullDialog' as any);
    expect(dialog.props.actions[1].disabled).toBe(false);

    await act(async () => dialog.props.actions[0].onPress());
    expect(tree.root.findAllByType('HullDialog' as any)).toHaveLength(0);

    await act(async () => hostByTestID(tree, 'create-room').props.onPress());
    dialog = tree.root.findByType('HullDialog' as any);
    await act(async () => dialog.props.onRequestClose());
    expect(tree.root.findAllByType('HullDialog' as any)).toHaveLength(0);
  });
});

describe('the legacy home is gone, not merely bypassed', () => {
  it('leaves exactly one screen that lists Rooms', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const root = path.join(__dirname, '../../../..', 'sources');
    const listers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.tsx$/.test(entry)) continue;
        const source = readFileSync(full, 'utf8');
        if (/listMyChannels\(|sessionsRead\(/.test(source)) listers.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(listers).toEqual(['app/(app)/buzz/channels.tsx']);
  });

  it('keeps the app root a redirect into that one home, with no list of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const source = readFileSync(path.join(__dirname, '../index.tsx'), 'utf8');
    expect(source).toContain("router.replace('/buzz/channels')");
    expect(source).not.toMatch(/FlatList|SessionsList|sessionsRead/);
  });
});
