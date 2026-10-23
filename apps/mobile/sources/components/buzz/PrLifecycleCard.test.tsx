import React from 'react';
// @ts-expect-error test renderer declarations are not installed.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { completeTestTheme } from '@/test/test-theme';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { anchorCornerMarkers } from '@/buzz/corner-markers';
import { foldPrLifecycleRuns } from '@/buzz/pr-lifecycle';

vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { Text: host('Text'), View: host('View'), Pressable: host('Pressable') };
});
import { NotificationLifecycleCard } from './PrLifecycleCard';
vi.mock('./Ledger', () => ({ LEDGER_MARGINALIA_WIDTH: 36 }));
vi.mock('./LifecycleRow', () => ({ LifecycleRow: () => null }));
import { LifecycleRecordCard } from './LifecycleCard';
import { CornerOpenedMarker } from './CornerOpenedMarker';
import { CornerBranchGlyph } from './CornerBranchGlyph';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const theme = completeTestTheme();
const item = {
  id: 'pr',
  state: 'Merged',
  title: 'Keep agent lead and body text in the same font face',
  kind: 'pull-request' as const,
  kindLine: 'PR #2742',
  url: 'https://github.com/Beeline-Work/beeline/pull/2742',
  cornerId: 'corner',
  actor: 'ruby',
  updatedBy: 'pr',
};
const issue = {
  ...item,
  id: 'issue',
  state: 'Filed',
  kind: 'issue' as const,
  kindLine: 'Issue #2744',
  url: 'https://github.com/Beeline-Work/beeline/issues/2744',
  cornerId: undefined,
};
function render(items = [item]) {
  const onOpenCorner = vi.fn(),
    onOpenUrl = vi.fn();
  let tree: any;
  act(() => {
    tree = create(
      <NotificationLifecycleCard
        message={
          { id: 'run', notificationLifecycleRun: { items, subline: '' } } as ChatDisplayMessage
        }
        onOpenCorner={onOpenCorner}
        onOpenUrl={onOpenUrl}
      />,
    );
  });
  const get = (id: string) =>
    tree.root.findAll((node: any) => node.props.testID === id && typeof node.type === 'string')[0];
  return { tree, get, onOpenCorner, onOpenUrl };
}
const text = (node: any): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(text).join('')
      : text(node?.props?.children ?? []);

describe('mock A lifecycle rows', () => {
  it('keeps grouped GitHub disclosures borderless with a full-height tap target', () => {
    const { get } = render([item, issue] as any);
    expect(get('notification-run-run').props.style?.borderTopWidth ?? 0).toBe(0);
    expect(get('notification-run-expand-run').props.style.minHeight).toBeGreaterThanOrEqual(44);
    act(() => get('notification-run-expand-run').props.onPress());
    expect(get('notification-run-cell-pr')).toBeDefined();
    act(() => get('notification-run-expand-run').props.onPress());
    expect(get('notification-run-cell-pr')).toBeUndefined();
    // A standalone repository record keeps its own section rule.
    expect(render().get('notification-run-run').props.style.borderTopWidth).toBe(1);
  });

  it('keeps the shared check-event disclosure borderless and at least 44 high', () => {
    const { get } = render([{ ...item, kind: 'check', state: 'Checks passed' }] as any);
    const row = get('notification-run-expand-run');
    expect(row.props.style.borderTopWidth ?? 0).toBe(0);
    expect(row.props.style.minHeight).toBeGreaterThanOrEqual(44);
    act(() => row.props.onPress());
    expect(get('notification-run-cell-pr')).toBeDefined();
    act(() => row.props.onPress());
    expect(get('notification-run-cell-pr')).toBeUndefined();
  });

  it('shows a single row without a header and keeps the two destinations separate', () => {
    const { tree, get, onOpenCorner, onOpenUrl } = render();
    expect(get('notification-run-expand-run')).toBeUndefined();
    expect(text(get('notification-run-cell-pr'))).toBe(`Merged #2742 ${item.title}`);
    act(() => get('notification-run-cell-url-pr').props.onPress());
    expect(onOpenUrl).toHaveBeenCalledWith(item.url);
    expect(onOpenCorner).not.toHaveBeenCalled();
    act(() => get('notification-run-cell-corner-pr').props.onPress());
    expect(onOpenCorner).toHaveBeenCalledWith('corner');
    for (const id of ['url', 'corner'])
      expect(get(`notification-run-cell-${id}-pr`).props.style).toMatchObject({
        minHeight: 44,
        minWidth: 44,
      });
    const title = tree.root
      .findAllByType('Text')
      .find((node: any) => node.props.numberOfLines === 2);
    expect(title.props.style.fontFamily).toBe(theme.buzz.type.body.fontFamily);
    expect(title.props.style.color).toBe(theme.buzz.textSecondary);
    expect(tree.root.findAllByType(CornerBranchGlyph)).toHaveLength(0);
  });
  it('shows issues without a corner arrow and opens their GitHub URL', () => {
    const { get, onOpenUrl } = render([issue] as any);
    expect(get('notification-run-cell-corner-issue')).toBeUndefined();
    act(() => get('notification-run-cell-url-issue').props.onPress());
    expect(onOpenUrl).toHaveBeenCalledWith(issue.url);
  });
  it('collapses groups to meta sans and reveals long runs through N more', () => {
    const { tree, get } = render([
      item,
      issue,
      { ...item, id: 'third' },
      { ...item, id: 'fourth' },
      { ...item, id: 'fifth' },
    ] as any);
    const header = get('notification-run-expand-run');
    expect(text(header)).toBe('4 PRs merged · 1 issue filed');
    const label = tree.root
      .findAllByType('Text')
      .find((node: any) => text(node) === '4 PRs merged · 1 issue filed');
    expect(label.props.style.fontFamily).toBe(theme.buzz.type.meta.fontFamily);
    expect(label.props.style.fontFamily).not.toBe(theme.buzz.monoRegular);
    expect(get('notification-run-cell-pr')).toBeUndefined();
    act(() => header.props.onPress());
    expect(get('notification-run-cell-pr')).toBeDefined();
    expect(get('notification-run-cell-third')).toBeUndefined();
    expect(text(get('notification-run-more-run'))).toBe('3 more');
    act(() => get('notification-run-more-run').props.onPress());
    expect(get('notification-run-cell-third')).toBeDefined();
    act(() => header.props.onPress());
    expect(get('notification-run-cell-pr')).toBeUndefined();
  });
  it('renders a nonresident source as a Room lifecycle row without a branch', () => {
    const fact: ChatDisplayMessage = {
      id: 'open',
      text: '',
      timestamp: 1,
      isUser: false,
      daemonFact: {
        type: 'corner-open',
        cornerId: 'corner',
        name: 'dm-unread-clear',
        objective: 'Clear unread',
        sourceMessageId: 'dm-source',
      },
    };
    const rows = foldPrLifecycleRuns(anchorCornerMarkers([fact]));
    const { tree, get } = render(rows[0].notificationLifecycleRun!.items as any);
    expect(text(get('notification-run-cell-open'))).toBe('Opened corner #dm-unread-clear');
    expect(tree.root.findAllByType(CornerBranchGlyph)).toHaveLength(0);
    const source: ChatDisplayMessage = {
      id: 'dm-source',
      text: 'Do it',
      timestamp: 0,
      isUser: true,
    };
    const anchored = foldPrLifecycleRuns(anchorCornerMarkers([source, fact]));
    expect(anchored).toHaveLength(1);
    expect(anchored[0].cornerMarkers?.[0].id).toBe('open');
  });
});

it('shares Space Grotesk across grouped rows, standalone adapters and source markers', () => {
  let tree: any;
  act(() => {
    tree = create(
      <>
        <NotificationLifecycleCard
          message={
            {
              id: 'fonts',
              notificationLifecycleRun: { items: [item, issue], subline: '' },
            } as ChatDisplayMessage
          }
          onOpenCorner={() => undefined}
          onOpenUrl={() => undefined}
        />
        <LifecycleRecordCard
          item={item}
          timestamp={1}
          testID="standalone-fonts"
          onOpenCorner={() => undefined}
          onOpenUrl={() => undefined}
        />
        <CornerOpenedMarker title="shared-face" onOpen={() => undefined} />
      </>,
    );
  });
  act(() =>
    tree.root
      .findAllByType('Pressable')
      .find((node: any) => node.props.testID === 'notification-run-expand-fonts')
      .props.onPress(),
  );
  const texts = tree.root.findAllByType('Text');
  const flatten = (style: any): any =>
    Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : (style ?? {});
  const families = texts.map((node: any) => flatten(node.props.style).fontFamily).filter(Boolean);
  expect(families.length).toBeGreaterThan(5);
  for (const family of families) expect(family).toMatch(/^SpaceGrotesk-/);
  const titles = texts.filter((node: any) => node.props.numberOfLines === 2);
  expect(titles).toHaveLength(4);
  const marker = texts.find((node: any) => text(node).startsWith('Opened corner'));
  expect(flatten(marker.props.style).fontFamily).toMatch(/^SpaceGrotesk-/);
  for (const title of titles)
    expect(flatten(title.props.style).fontFamily).toBe(flatten(marker.props.style).fontFamily);
});

it('draws the call-site corner line as the Room row with the branch mark in front', () => {
  const fact: ChatDisplayMessage = {
    id: 'open',
    text: '',
    timestamp: 1,
    isUser: false,
    daemonFact: {
      type: 'corner-open',
      cornerId: 'corner',
      name: 'font-check-android',
      objective: 'Check fonts',
      sourceMessageId: 'dm-source',
    },
  };
  const room = render(
    foldPrLifecycleRuns(anchorCornerMarkers([fact]))[0].notificationLifecycleRun!.items as any,
  );
  let callSite: any;
  act(() => {
    callSite = create(<CornerOpenedMarker title="font-check-android" onOpen={() => undefined} />);
  });
  const flatten = (style: any): any =>
    Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : (style ?? {});
  // Words, then font family, size, weight and colour of every run of text.
  const format = (tree: any) => {
    const [line] = tree.root.findAll(
      (node: any) => node.type === 'Text' && node.props.numberOfLines === 2,
    );
    return {
      words: text(line),
      runs: line
        .findAll((node: any) => node.type === 'Text')
        .map((node: any) => {
          const style = flatten(node.props.style);
          return [
            style.fontFamily,
            style.fontSize,
            style.lineHeight,
            style.fontWeight,
            style.color,
          ];
        }),
    };
  };
  expect(format(room.tree).words).toBe('Opened corner #font-check-android');
  expect(format(callSite)).toEqual(format(room.tree));
  expect(room.tree.root.findAllByType(CornerBranchGlyph)).toHaveLength(0);
  expect(callSite.root.findAllByType(CornerBranchGlyph)).toHaveLength(1);
});

it('opens the corner when the text of a corner row or call-site line is pressed (Reproduction corner-row-tap-1)', () => {
  // The press lands on the words, so it opens whatever target holds them.
  const pressText = (tree: any, words: string) => {
    let node = tree.root.find(
      (candidate: any) => candidate.type === 'Text' && text(candidate) === words,
    );
    while (node && !(node.type === 'Pressable' && node.props.onPress)) node = node.parent;
    expect(node).toBeTruthy();
    act(() => node.props.onPress());
  };
  const fact: ChatDisplayMessage = {
    id: 'open',
    text: '',
    timestamp: 1,
    isUser: false,
    daemonFact: {
      type: 'corner-open',
      cornerId: 'corner-font-check',
      name: 'font-check-android',
      objective: 'Check fonts',
      sourceMessageId: 'dm-source',
    },
  };
  const room = render(
    foldPrLifecycleRuns(anchorCornerMarkers([fact]))[0].notificationLifecycleRun!.items as any,
  );
  pressText(room.tree, 'Opened corner #font-check-android');
  expect(room.onOpenCorner).toHaveBeenCalledWith('corner-font-check');
  expect(room.onOpenUrl).not.toHaveBeenCalled();

  const onOpen = vi.fn();
  let callSite: any;
  act(() => {
    callSite = create(<CornerOpenedMarker title="font-check-android" onOpen={onOpen} />);
  });
  pressText(callSite, 'Opened corner #font-check-android');
  expect(onOpen).toHaveBeenCalledTimes(1);

  // A PR row keeps its two targets: the title opens GitHub, the chevron the corner.
  const pr = render();
  pressText(pr.tree, `Merged #2742 ${item.title}`);
  expect(pr.onOpenUrl).toHaveBeenCalledWith(item.url);
  expect(pr.onOpenCorner).not.toHaveBeenCalled();
  act(() => pr.get('notification-run-cell-corner-pr').props.onPress());
  expect(pr.onOpenCorner).toHaveBeenCalledWith('corner');
});

it('keeps each surface’s closed wording in the shared format', () => {
  const closed = render([
    {
      ...item,
      id: 'closed',
      state: 'Closed',
      kind: 'corner' as const,
      kindLine: 'corner',
      url: undefined,
      title: 'quiet',
    },
  ] as any);
  expect(text(closed.get('notification-run-cell-closed'))).toBe('Closed corner #quiet');
  let callSite: any;
  act(() => {
    callSite = create(<CornerOpenedMarker title="quiet" closed onOpen={() => undefined} />);
  });
  const lines = (tree: any) =>
    tree.root.findAll((node: any) => node.type === 'Text' && node.props.numberOfLines === 2);
  const [line] = lines(callSite);
  expect(text(line)).toBe('Corner closed · #quiet');
  const flatten = (style: any): any =>
    Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : (style ?? {});
  const runs = (node: any) =>
    node
      .findAll((n: any) => n.type === 'Text')
      .map((n: any) => {
        const style = flatten(n.props.style);
        return [style.fontFamily, style.fontSize, style.fontWeight, style.color];
      });
  expect(runs(line)).toEqual(runs(lines(closed.tree)[0]));
});
