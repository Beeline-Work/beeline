import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { Platform: { OS: 'web' }, Pressable: host('Pressable'), Text: host('Text') };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) =>
      factory({
        colors: { groupped: { background: '#100915' }, divider: '#333', textSecondary: '#888' },
        buzz: { accent: '#b08a4a', type: { machine: {} } },
      }),
  },
}));

import { DesktopWorkPaneHandle } from './DesktopWorkPaneHandle';
import { DESKTOP_CORNER_DRAG_TYPE } from '@/buzz/desktop-work-pane';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});
afterAll(() => vi.restoreAllMocks());

describe('DesktopWorkPaneHandle', () => {
  it('is keyboard focusable, named, and opens the overview on click', () => {
    const onOpen = vi.fn();
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <DesktopWorkPaneHandle roomId="room-1" onOpen={onOpen} onDropCorner={vi.fn()} />,
      );
    });
    const handle = tree.root.findByProps({ testID: 'desktop-work-pane-handle' });
    expect(handle.props.accessibilityLabel).toBe('Open work pane');
    expect(handle.props.accessibilityRole).toBe('button');
    expect(handle.props.focusable).toBe(true);
    const restingStyle = handle.props.style;
    act(() => handle.props.onFocus());
    expect(tree.root.findByProps({ testID: 'desktop-work-pane-handle' }).props.style).not.toEqual(
      restingStyle,
    );
    act(() => handle.props.onPress());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('widens with drop copy and opens a dragged corner in the work pane', () => {
    const onDropCorner = vi.fn();
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <DesktopWorkPaneHandle roomId="room-1" onOpen={vi.fn()} onDropCorner={onDropCorner} />,
      );
    });
    const dataTransfer = {
      dropEffect: 'none',
      getData: (type: string) =>
        type === DESKTOP_CORNER_DRAG_TYPE
          ? JSON.stringify({ roomId: 'room-1', cornerId: 'corner-1' })
          : '',
    };
    const event = { dataTransfer, preventDefault: vi.fn() };
    const dropTarget = tree.root.findByProps({ 'data-testid': 'desktop-work-pane-drop-target' });
    act(() => dropTarget.props.onDragEnter(event));
    expect(tree.root.findByType('Text' as any).props.children).toBe('DROP TO OPEN IN WORK PANE');
    act(() => dropTarget.props.onDrop(event));
    expect(onDropCorner).toHaveBeenCalledWith('corner-1');
    expect(tree.root.findByType('Text' as any).props.children).toBe('‹');
  });
});
