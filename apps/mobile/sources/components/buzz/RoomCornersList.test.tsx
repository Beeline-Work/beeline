import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CornerListItem } from '@beeline/buzz-client';
import { RoomCornersList } from './RoomCornersList';
import { RoomCornersHeader } from './RoomCornersHeader';
import { beelineThemes } from '@/buzz/groknight';

const routerPush = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    FlatList: (props: any) =>
      ReactModule.createElement(
        'FlatList',
        props,
        ...(props.data ?? []).map((item: any, index: number) =>
          ReactModule.createElement(
            ReactModule.Fragment,
            { key: props.keyExtractor(item, index) },
            props.renderItem({ item, index }),
          ),
        ),
        props.ListFooterComponent,
        (props.data ?? []).length === 0 ? props.ListEmptyComponent : null,
      ),
    Pressable: host('Pressable'),
    TouchableOpacity: host('TouchableOpacity'),
    Platform: { OS: 'web' },
    Text: host('Text'),
    View: host('View'),
  };
});

// The real token set, so row geometry and tone assertions read the same
// values the app ships rather than a stub that drifts from them.
vi.mock('react-native-unistyles', async () => {
  const { beelineThemes } = await import('@/buzz/groknight');
  const theme = { buzz: beelineThemes.obsidian };
  return {
    StyleSheet: {
      hairlineWidth: 1,
      create: (factory: any) => (typeof factory === 'function' ? factory(theme) : factory),
    },
  };
});
vi.mock('expo-router', () => ({ router: { push: routerPush } }));
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return { StateCircle: (props: any) => ReactModule.createElement('StateCircle', props) };
});
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});

const VIEWER = 'viewer-pubkey';

/** A corner the viewer commissioned, so it lands in the open Mine section. */
function corner(id: string, state: CornerListItem['state'], name = id): CornerListItem {
  return {
    corner: {
      id,
      workspaceId: 'workspace',
      name,
      archived: state === 'archived',
      createdAt: 1,
      updatedAt: 2,
    },
    lifecycle: { lifecycle: state === 'archived' ? 'done' : 'active', checks: 'unknown' },
    state,
    stateAt: 2,
    agent: { pubkey: `agent-${id}`, name: `Opener ${id}`, kind: 'agent' },
    initiator: { pubkey: VIEWER, name: 'Viewer', kind: 'human' },
  } as CornerListItem;
}

/** A corner someone else commissioned, which lands in the folded Others section. */
function theirs(id: string, state: CornerListItem['state'] = 'working'): CornerListItem {
  return { ...corner(id, state), initiator: { pubkey: 'someone', name: 'Sam', kind: 'human' } };
}

function text(tree: ReactTestRenderer): string {
  return tree.root
    .findAllByType('Text' as any)
    .flatMap((node: any) => node.props.children)
    .join(' ')
    .replace(/\s+/g, ' ');
}

function render(
  corners: readonly CornerListItem[],
  extra: Partial<React.ComponentProps<typeof RoomCornersList>> = {},
) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <RoomCornersList
        corners={corners}
        parentRoomName="#alpha"
        parentRoomId="room-1"
        viewerPubkey={VIEWER}
        {...extra}
      />,
    );
  });
  return tree;
}

function pressable(tree: ReactTestRenderer, testID: string) {
  return tree.root
    .findAllByType('Pressable' as any)
    .find((node: any) => node.props.testID === testID);
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('RoomCornersList', () => {
  const rowIds = (tree: ReactTestRenderer) =>
    tree.root
      .findAllByType('Pressable' as any)
      .map((node: any) => String(node.props.testID ?? ''))
      .filter((testID: string) => /^room-corner-/.test(testID));

  it('opens Mine with every corner of the viewer, uncapped, and folds Others behind its count', () => {
    const mine = Array.from({ length: 7 }, (_, index) => corner(`mine-${index}`, 'working'));
    const tree = render([...mine, theirs('theirs-0'), theirs('theirs-1'), theirs('theirs-2')]);
    expect(rowIds(tree)).toEqual(mine.map((item) => `room-corner-${item.corner.id}`));
    expect(pressable(tree, 'room-corners-mine').props.accessibilityLabel).toBe('Mine · 7');
    expect(pressable(tree, 'room-corners-mine').props.accessibilityState).toMatchObject({
      expanded: true,
    });
    const others = pressable(tree, 'room-corners-others');
    expect(others.props.accessibilityLabel).toBe('Others · 3');
    expect(others.props.accessibilityState).toMatchObject({ expanded: false });

    act(() => others.props.onPress());
    expect(rowIds(tree)).toHaveLength(10);
    expect(rowIds(tree).slice(7)).toEqual([
      'room-corner-theirs-0',
      'room-corner-theirs-1',
      'room-corner-theirs-2',
    ]);
    act(() => pressable(tree, 'room-corners-mine').props.onPress());
    expect(rowIds(tree)).toEqual([
      'room-corner-theirs-0',
      'room-corner-theirs-1',
      'room-corner-theirs-2',
    ]);
  });

  it('counts a corner waiting on the viewer as Mine and one waiting on someone else as Others', () => {
    const tree = render([
      { ...theirs('asks-me', 'waiting'), awaitsViewer: true },
      theirs('asks-them', 'waiting'),
    ]);
    expect(rowIds(tree)).toEqual(['room-corner-asks-me']);
    expect(pressable(tree, 'room-corners-others').props.accessibilityLabel).toBe('Others · 1');
  });

  it('does not remember a fold: a fresh screen starts with Mine open and Others folded', () => {
    const first = render([corner('mine', 'working'), theirs('theirs')]);
    act(() => pressable(first, 'room-corners-others').props.onPress());
    act(() => pressable(first, 'room-corners-mine').props.onPress());
    expect(rowIds(first)).toEqual(['room-corner-theirs']);
    const second = render([corner('mine', 'working'), theirs('theirs')]);
    expect(rowIds(second)).toEqual(['room-corner-mine']);
  });

  it('leaves out the heading of a section with nothing in it', () => {
    const tree = render([corner('mine', 'working')]);
    expect(pressable(tree, 'room-corners-others')).toBeUndefined();
    const onlyTheirs = render([theirs('theirs')]);
    expect(pressable(onlyTheirs, 'room-corners-mine')).toBeUndefined();
    expect(pressable(onlyTheirs, 'room-corners-others')).toBeTruthy();
  });

  it('names an empty Room instead of inventing a list', () => {
    const tree = render([]);
    expect(tree.root.findByProps({ testID: 'room-corners-empty' })).toBeTruthy();
    expect(text(tree)).toContain('No corners yet');
  });

  it.each([
    ['working', 'working', 'quiet', 'ledgerQuiet'],
    ['waiting', 'idle', 'brass', 'accent'],
    ['review', 'needs-you', 'quiet', 'ledgerQuiet'],
    ['archived', 'idle', 'ghost', 'ledgerGhost'],
  ] as const)('renders %s with its state word, circle and tone', (state, visual, tone, color) => {
    const tree = render([corner('live', state, 'Fix fixture')]);
    // Narrowed by testID as well as type: the archived footer is a Pressable
    // too, and it stands on every list.
    const row = tree.root
      .findAllByType('Pressable' as any)
      .find((node: any) => node.props.testID === 'room-corner-live');
    const circle = tree.root.findByType('StateCircle' as any);
    const label = row
      .findAllByType('Text' as any)
      .find((node: any) => node.props.children === state);
    expect(label).toBeDefined();
    expect(resolvedStyle(label.props.style)).toMatchObject({
      ...beelineThemes.obsidian.type.sectionHead,
      color: beelineThemes.obsidian[color],
    });
    expect(circle.props).toMatchObject({ state: visual, tone });
    expect(row.children[row.children.length - 2].findByType('Text' as any)).toBe(label);
    expect(row.children[row.children.length - 1].findByType('StateCircle' as any)).toBe(circle);
    expect(row.props.accessibilityLabel).toContain(state);
    expect(row.props.accessibilityLabel).toContain('Opened by Opener live');
    expect(resolvedStyle(row.props.style).minHeight).toBe(beelineThemes.obsidian.layout.row);
    // Captain 2026-09-20: the opener's face is secondary to the corner's
    // name, so it takes the byline tile size, not the Room-list row's.
    expect(row.findByType('IdentityMark' as any).props.size).toBe(26);
    const texts = row.findAllByType('Text' as any);
    expect(resolvedStyle(texts[0].props.style)).toMatchObject(beelineThemes.obsidian.type.body);
    expect(resolvedStyle(texts[1].props.style)).toMatchObject(beelineThemes.obsidian.type.meta);
  });

  it('carries the corner PR/check narration on the row it belongs to', () => {
    const item = corner('live', 'working', 'Fix fixture');
    const tree = render([
      {
        ...item,
        lifecycle: {
          ...item.lifecycle,
          pr: { number: 12, url: 'https://example.invalid/12' },
          checks: 'passing',
          checksSummary: { status: 'passing', total: 3, checks: [], failing: [] },
        },
      } as unknown as CornerListItem,
    ]);
    expect(text(tree)).toContain('Opened by Opener live · PR #12 · all 3 tests passed');
  });

  it('uses the human creator as the opener when a corner has no agent', () => {
    const item = corner('notes', 'waiting', 'Release notes');
    const tree = render([
      {
        ...item,
        agent: undefined,
        initiator: { pubkey: 'person-1', kind: 'human', name: 'Avery' },
      },
    ], { viewerPubkey: 'person-1' });
    const row = tree.root.findByProps({ testID: 'room-corner-notes' });
    expect(row.props.accessibilityLabel).toContain('Opened by Avery');
    expect(row.findByType('IdentityMark' as any).props).toMatchObject({
      kind: 'human',
      seed: 'person-1',
      name: 'Avery',
    });
  });

  it.each([0, 24, 48])('keeps the last row clear of a %s-point gesture bar', (bottomInset) => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <RoomCornersList
          corners={[corner('live', 'working')]}
          parentRoomName="#alpha"
          parentRoomId="room-1"
          viewerPubkey={VIEWER}
          bottomInset={bottomInset}
        />,
      );
    });
    const list = tree.root.findByType('FlatList' as any);
    expect(resolvedStyle(list.props.contentContainerStyle).paddingBottom).toBe(bottomInset);
  });

  it('reserves the trailing state column so every title truncates at one x', () => {
    // F2 from the impeccable audit: `working`, `waiting`, `review` and
    // `archived` are four different widths. Without a reserved cell the title
    // ends at a different x on each row and the words do not read down one
    // edge, which is what DESIGN.md's index rule forbids.
    const tree = render([
      corner('a', 'working', 'Alpha'),
      corner('b', 'waiting', 'Beta'),
      corner('c', 'review', 'Gamma'),
    ]);
    const flatten = (style: any): any[] => ([] as any[]).concat(style ?? []).filter(Boolean);
    const cells = tree.root
      .findAllByType('Text' as any)
      .flatMap((node: any) => flatten(node.props.style))
      .filter((style: any) => style.textTransform === 'uppercase');
    expect(cells.length).toBeGreaterThanOrEqual(3);
    for (const cell of cells) {
      expect(cell.minWidth).toBeGreaterThan(0);
      expect(cell.textAlign).toBe('right');
    }
    const widths = new Set(cells.map((cell: any) => cell.minWidth));
    expect(widths.size).toBe(1);
  });

  it('prints the corner name in full rather than truncating it', () => {
    // Captain 2026-09-20: no ellipsis on a corner name. It wraps, and the row
    // grows to hold it; uneven row heights are the accepted cost.
    const longName =
      'Restore the corners index header metrics and reconcile the archived fallback window';
    const tree = render([corner('long', 'waiting', longName)]);
    const row = tree.root.findByProps({ testID: 'room-corner-long' });
    const texts = row
      .findAllByType('Text' as any)
      .map((node: any) => ({ node, text: [node.props.children].flat().join('') }));
    type TitleEntry = { node: any; text: string };
    const title = texts.find((entry: TitleEntry) => entry.text.includes(longName))?.node;
    expect(
      title,
      `the row must render the whole name, got: ${texts
        .map((entry: TitleEntry) => entry.text)
        .join(' | ')}`,
    ).toBeTruthy();
    expect(title.props.numberOfLines).toBeUndefined();
    expect(resolvedStyle(row.props.style).minHeight).toBe(beelineThemes.obsidian.layout.row);
    expect(resolvedStyle(row.props.style).height).toBeUndefined();
  });

  it('opens a row into that corner, returning to this corners screen on back', () => {
    const tree = render([corner('live', 'working', 'Fix fixture')]);
    act(() => tree.root.findByProps({ testID: 'room-corner-live' }).props.onPress());
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'live', parent: 'room-1', title: 'Fix fixture', returnTo: 'corners' },
    });
  });

  it.each([false, true])(
    'opens a bound app as the entire corner surface when embedsChat is %s',
    (embedsChat) => {
      const item: CornerListItem = {
        ...corner('app-corner', 'waiting', 'Release control'),
        app: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          manifest: {
            version: 1,
            slug: 'release-board',
            title: 'Release board',
            developer: 'Bee Labs',
            humanUi: {
              kind: 'broker',
              capability: 'release-board.ui',
              ...(embedsChat ? { embedsChat: true } : {}),
            },
          },
        },
      };
      const tree = render([item]);
      act(() => tree.root.findByProps({ testID: 'room-corner-app-corner' }).props.onPress());
      expect(routerPush).toHaveBeenCalledWith({
        pathname: '/beeline/corner-app/[slug]',
        params: { slug: 'release-board', roomId: 'app-corner' },
      });
    },
  );
});

function resolvedStyle(style: any): Record<string, any> {
  return Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
}

describe('RoomCornersList archived footer', () => {
  const NOW_MS = 1_000_000_000_000;
  const NOW_SECONDS = NOW_MS / 1000;
  const closed = (id: string, name: string, agoSeconds: number): CornerListItem => ({
    ...corner(id, 'archived', name),
    closedAt: NOW_SECONDS - agoSeconds,
  });
  const cornerRowIds = (tree: ReactTestRenderer) =>
    tree.root
      .findAllByType('Pressable' as any)
      .map((node: any) => String(node.props.testID ?? ''))
      .filter((testID: string) => /^room-corner-/.test(testID));

  it('stands the door open on every Room, including one with no live corners', () => {
    const onShowArchived = vi.fn();
    const tree = render([], { onShowArchived });
    const door = pressable(tree, 'room-corners-archived');
    expect(door).toBeTruthy();
    expect(door.props.accessibilityRole).toBe('button');
    expect(door.props.disabled).toBe(false);
    expect(text(tree)).toContain('Archived corners');
    // The empty Room still says it is empty: the door reports nothing about
    // whether there IS closed work until someone asks for it.
    expect(tree.root.findByProps({ testID: 'room-corners-empty' })).toBeTruthy();
    act(() => door.props.onPress());
    expect(onShowArchived).toHaveBeenCalledOnce();
  });

  it('starts folded and opens on the first tap', () => {
    const onShowArchived = vi.fn();
    const tree = render([corner('live', 'working')], { onShowArchived });
    const door = pressable(tree, 'room-corners-archived');
    expect(door.props.accessibilityState).toMatchObject({ expanded: false });
    act(() => door.props.onPress());
    expect(onShowArchived).toHaveBeenCalledOnce();
  });

  it('says the fetch was heard while it is in flight', () => {
    const onShowArchived = vi.fn();
    const tree = render([corner('live', 'working')], {
      archived: { status: 'loading' },
      onShowArchived,
    });
    expect(text(tree)).toContain('Loading archived corners…');
    expect(tree.root.findByProps({ testID: 'room-corners-archived-loading' })).toBeTruthy();
    // Disabled, so a second tap cannot start a second fetch.
    expect(pressable(tree, 'room-corners-archived').props.disabled).toBe(true);
  });

  it('lands the fetched corners under the door, each stamped with its closure age', () => {
    const tree = render([corner('live', 'working')], {
      nowMs: NOW_MS,
      archived: {
        status: 'ready',
        corners: [
          closed('recent', 'Recent work', 2 * 60 * 60),
          closed('older', 'Older work', 3 * 86_400),
        ],
      },
    });
    // Landed but folded: the page opens with Archived closed.
    expect(cornerRowIds(tree)).toEqual(['room-corner-live']);
    act(() => pressable(tree, 'room-corners-archived').props.onPress());
    expect(cornerRowIds(tree)).toEqual([
      'room-corner-live',
      'room-corner-recent',
      'room-corner-older',
    ]);
    expect(text(tree)).toContain('Archived corners · 2');
    expect(pressable(tree, 'room-corner-recent').props.accessibilityLabel).toContain(
      'closed 2h ago',
    );
    expect(pressable(tree, 'room-corner-older').props.accessibilityLabel).toContain(
      'closed 3d ago',
    );
    // A live corner has no closure, so it carries no stamp.
    expect(pressable(tree, 'room-corner-live').props.accessibilityLabel).not.toContain('closed');
    // Landed work folds without another read.
    act(() => pressable(tree, 'room-corners-archived').props.onPress());
    expect(cornerRowIds(tree)).toEqual(['room-corner-live']);
  });

  it('offers More under the archived rows while the server has another page', () => {
    const onMoreArchived = vi.fn();
    const page = Array.from({ length: 10 }, (_, index) =>
      closed(`done-${index}`, `Done ${index}`, (index + 1) * 60),
    );
    const tree = render([], {
      nowMs: NOW_MS,
      onMoreArchived,
      archived: { status: 'ready', corners: page, next: 'cursor' },
    });
    act(() => pressable(tree, 'room-corners-archived').props.onPress());
    expect(cornerRowIds(tree)).toHaveLength(10);
    expect(text(tree)).toContain('Archived corners · 10+');
    const more = pressable(tree, 'room-corners-archived-more');
    expect(more.props.accessibilityLabel).toBe('More archived corners');
    act(() => more.props.onPress());
    expect(onMoreArchived).toHaveBeenCalledOnce();

    act(() =>
      tree.update(
        <RoomCornersList
          corners={[]}
          parentRoomName="#alpha"
          parentRoomId="room-1"
          viewerPubkey={VIEWER}
          nowMs={NOW_MS}
          onMoreArchived={onMoreArchived}
          archived={{ status: 'ready', corners: page, next: 'cursor', more: { status: 'loading' } }}
        />,
      ),
    );
    expect(pressable(tree, 'room-corners-archived-more').props.disabled).toBe(true);
    expect(tree.root.findByProps({ testID: 'room-corners-archived-more-loading' })).toBeTruthy();

    act(() =>
      tree.update(
        <RoomCornersList
          corners={[]}
          parentRoomName="#alpha"
          parentRoomId="room-1"
          viewerPubkey={VIEWER}
          nowMs={NOW_MS}
          onMoreArchived={onMoreArchived}
          archived={{
            status: 'ready',
            corners: page,
            next: 'cursor',
            more: { status: 'error', reason: 'Beeline is offline' },
          }}
        />,
      ),
    );
    expect(text(tree)).toContain('Beeline is offline. Tap to retry');
    act(() => pressable(tree, 'room-corners-archived-more').props.onPress());
    expect(onMoreArchived).toHaveBeenCalledTimes(2);

    act(() =>
      tree.update(
        <RoomCornersList
          corners={[]}
          parentRoomName="#alpha"
          parentRoomId="room-1"
          viewerPubkey={VIEWER}
          nowMs={NOW_MS}
          archived={{ status: 'ready', corners: [...page, closed('last', 'Last', 86_400)] }}
        />,
      ),
    );
    expect(cornerRowIds(tree)).toHaveLength(11);
    expect(pressable(tree, 'room-corners-archived-more')).toBeUndefined();
  });

  it('retires the empty state once archived work is on screen', () => {
    const tree = render([], {
      nowMs: NOW_MS,
      archived: { status: 'ready', corners: [closed('done', 'Landed work', 86_400)] },
    });
    act(() => pressable(tree, 'room-corners-archived').props.onPress());
    expect(tree.root.findAllByProps({ testID: 'room-corners-empty' })).toHaveLength(0);
    expect(cornerRowIds(tree)).toEqual(['room-corner-done']);
  });

  it('names a Room whose archive is genuinely empty', () => {
    const tree = render([corner('live', 'working')], {
      archived: { status: 'ready', corners: [] },
    });
    expect(text(tree)).toContain('No archived corners');
  });

  it('offers the retry in the footer when the fetch failed', () => {
    const onShowArchived = vi.fn();
    const tree = render([corner('live', 'working')], {
      archived: { status: 'error', reason: 'Beeline is offline' },
      onShowArchived,
    });
    const door = pressable(tree, 'room-corners-archived');
    expect(text(tree)).toContain('Beeline is offline. Tap to retry');
    expect(door.props.disabled).toBe(false);
    act(() => door.props.onPress());
    expect(onShowArchived).toHaveBeenCalledOnce();
  });
});

describe('RoomCornersHeader', () => {
  it.each([0, 1, 2])('renders the slab header and accessible count for %s corners', (count) => {
    const onBack = vi.fn();
    const onAdd = vi.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <RoomCornersHeader title="#alpha" count={count} onBack={onBack} onAdd={onAdd} />,
      );
    });
    const hull = beelineThemes.obsidian;
    const header = tree.root.findAllByType('View' as any)[0];
    expect(resolvedStyle(header.props.style)).toMatchObject({
      borderBottomWidth: 1,
      borderBottomColor: hull.border,
      paddingHorizontal: hull.space.sm,
    });
    expect(resolvedStyle(header.props.style).backgroundColor).toBeUndefined();
    expect(tree.root.findAllByType('HullSurface' as any)).toHaveLength(0);
    // Three written parts. The back mark is drawn, so it is not one of them.
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.map((node: any) => node.props.children)).toEqual(['#alpha', 'Corners', count]);
    expect(tree.root.findAllByType('Polyline' as any)).toHaveLength(1);
    expect(resolvedStyle(texts[0].props.style)).toMatchObject(hull.type.meta);
    expect(resolvedStyle(texts[1].props.style)).toMatchObject(hull.type.hero);
    expect(texts[1].props.accessibilityRole).toBe('header');
    expect(resolvedStyle(texts[2].props.style)).toMatchObject(hull.type.meta);
    expect(texts[2].props.accessibilityLabel).toBe(
      `${count} ${count === 1 ? 'corner' : 'corners'}`,
    );
    const [back, add] = tree.root.findAllByType('TouchableOpacity' as any);
    expect(back.props).toMatchObject({ accessibilityRole: 'button', accessibilityLabel: 'Back' });
    expect(resolvedStyle(back.props.style)).toMatchObject({ width: 44, height: 44 });
    expect(add.props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityLabel: 'Create a corner',
      testID: 'room-corners-add',
    });
    expect(resolvedStyle(add.props.style)).toMatchObject({ width: 44, height: 44 });
    act(() => back.props.onPress());
    expect(onBack).toHaveBeenCalledOnce();
    act(() => add.props.onPress());
    expect(onAdd).toHaveBeenCalledOnce();
  });
});
