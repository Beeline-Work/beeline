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
