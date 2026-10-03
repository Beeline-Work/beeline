import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ChatListItem } from '@beeline/buzz-client';
import { ConversationRow } from './ConversationRow';

vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { Pressable: host('Pressable'), Text: host('Text'), View: host('View') };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: (props: any) => React.createElement('AnimatedView', props, props.children) },
  Easing: { out: () => 'out', cubic: 'cubic' },
  ReduceMotion: { System: 'system' },
  useAnimatedStyle: (style: () => unknown) => style(),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));
vi.mock('react-native-unistyles', () => {
  const token = new Proxy({}, { get: () => token });
  return {
    StyleSheet: { create: (factory: (theme: unknown) => unknown) => factory({ buzz: token }) },
  };
});
vi.mock('./CornerGlyph', () => ({ CornerGlyph: () => null }));
vi.mock('./PinGlyph', () => ({ PinGlyph: () => null }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const latestMessage = {
  id: 'latest',
  text: '@viewer The build is ready',
  createdAt: 100,
  author: { pubkey: 'speedy', kind: 'agent' as const, name: 'Speedy', handle: '@speedy' },
};

const mineCorner = { id: 'mine', name: 'My corner', state: 'working' as const, mine: true };
const otherCorner = { id: 'other', name: 'Other corner', state: 'working' as const };

function renderRow(
  changes: Partial<ChatListItem> = {},
  props: Partial<React.ComponentProps<typeof ConversationRow>> = {},
) {
  const item = {
    room: { id: 'room', name: 'experiments', updatedAt: 100 },
    latestMessage,
    ...changes,
  } as ChatListItem;
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <ConversationRow
        item={item}
        viewer="viewer"
        now={100_000}
        onPress={() => {}}
        onPin={() => {}}
        testID="room"
        {...props}
      />,
    );
  });
  const root = tree!.root;
  const preview = root.findByProps({ testID: 'room-preview' });
  const text = (node: any): string =>
    node.children.map((child: any) => (typeof child === 'string' ? child : text(child))).join('');
  const visibleText = text(preview);
  return { root, visibleText };
}

describe('ConversationRow preview', () => {
  it.each([false, true])(
    'hides empty corner controls and keeps unread dots (desktop=%s)',
    (desktop) => {
      for (const openCorners of [[otherCorner], [], undefined]) {
        const { root, visibleText } = renderRow(
          { cornerCount: 5, openCorners, unread: true },
          { desktop, cornersExpanded: true },
        );
        expect(root.findAllByProps({ testID: 'room-corners' })).toHaveLength(0);
        expect(root.findByProps({ testID: 'room-unread' }).props.accessibilityLabel).toBe(
          'new messages',
        );
        expect(visibleText).toBe('@speedy\u00a0\u00b7\u00a0@viewer The build is ready');
      }
    },
  );

  it.each([false, true])(
    'shows a viewer corner, counts listed corners and retains toggling (desktop=%s)',
    (desktop) => {
      const onToggleCorners = vi.fn();
      const item = { cornerCount: 5, openCorners: [otherCorner, mineCorner], unread: true };
      for (const cornersExpanded of [false, true]) {
        const shown = renderRow(item, { desktop, cornersExpanded, onToggleCorners }).root;
        const mark = shown.findByProps({ testID: 'room-corners' });
        expect(mark.props.style).toEqual(
          expect.arrayContaining([expect.objectContaining({ position: 'absolute' })]),
        );
        expect(mark.props.accessibilityLabel).toBe(
          `${cornersExpanded ? 'Collapse' : 'Expand'} 1 corners`,
        );
        expect(mark.props.accessibilityState).toEqual({ expanded: cornersExpanded });
        act(() => mark.props.onPress());
        expect(shown.findByProps({ testID: 'room-unread' }).props.accessibilityLabel).toBe(
          'new messages',
        );
      }
      expect(onToggleCorners).toHaveBeenCalledTimes(2);
    },
  );
  it('shows the latest sender and text for an unread mention while retaining its attention state', () => {
    const { root, visibleText } = renderRow({
      unread: true,
      latestMessage: { ...latestMessage, mentionsViewer: true },
    });
    expect(visibleText).toBe('@speedy\u00a0\u00b7\u00a0@viewer The build is ready');
    expect(root.findByProps({ testID: 'room-needs-you' }).props.accessibilityLabel).toBe(
      'needs you',
    );
    expect(
      root.findAllByProps({ testID: 'room' }).find((node: any) => node.type === 'Pressable')!.props
        .accessibilityLabel,
    ).toContain('needs you');
  });

  it('keeps ordinary and read mention previews', () => {
    expect(renderRow({ unread: true }).visibleText).toBe(
      '@speedy\u00a0\u00b7\u00a0@viewer The build is ready',
    );
    const read = renderRow({
      unread: false,
      latestMessage: { ...latestMessage, mentionsViewer: true },
    });
    expect(read.visibleText).toBe('@speedy\u00a0\u00b7\u00a0@viewer The build is ready');
    expect(read.root.findAllByProps({ testID: 'room-needs-you' })).toHaveLength(0);
  });

  it('keeps an approval reason in place of the preview', () => {
    const { root, visibleText } = renderRow({
      unread: true,
      agentState: 'needs-you',
      attentionReason: { kind: 'approval', actor: 'Hoots' },
      latestMessage: { ...latestMessage, mentionsViewer: true },
    });
    expect(visibleText).toBe('approval · Hoots');
    expect(root.findByProps({ testID: 'room-needs-you' })).toBeDefined();
  });
});
