import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { Platform: { OS: 'web' }, Pressable: host('Pressable'), Text: host('Text'), View: host('View') };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) =>
      factory({
        buzz: {
          accent: '#b08a4a',
          bgHighlight: '#1e1326',
          bgRaised: '#190e21',
          border: '#382d40',
          radius: 3,
          space: { sm: 8, xs: 4 },
          textPrimary: '#f0f0f3',
          type: { machine: { fontSize: 13 }, sectionHead: { fontSize: 10, lineHeight: 12 } },
        },
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
  const renderedStyle = (style: Array<Record<string, unknown> | false>) =>
    Object.assign({}, ...style.filter(Boolean));

  it('is a quiet edge-overlay tab with an accessible name', () => {
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
    expect(renderedStyle(handle.props.style)).toMatchObject({
      width: 14,
      height: 40,
      backgroundColor: '#190e21',
      borderTopWidth: 1,
      borderTopColor: '#382d40',
      borderLeftWidth: 1,
      borderLeftColor: '#382d40',
      borderBottomWidth: 1,
      borderBottomColor: '#382d40',
      borderTopLeftRadius: 3,
      borderBottomLeftRadius: 3,
    });
    // The handle's mark is a drawn chevron in a fixed box, not a character.
    const glyph = tree.root.findAllByProps({ testID: 'desktop-work-pane-handle-glyph' }).at(-1);
    expect(glyph!.props.width).toBe(14);
    expect(glyph!.props.height).toBe(14);
    expect(tree.root.findByType('Polyline' as any).props.stroke).toBe('#b08a4a');
    expect(
      tree.root.findByProps({ 'data-testid': 'desktop-work-pane-drop-target' }).props.style,
    ).toMatchObject({ alignSelf: 'stretch', flexDirection: 'column', width: 0, overflow: 'visible' });
    act(() => handle.props.onPress());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('steps to the hi surface and brass border on hover and restores on hover out', () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <DesktopWorkPaneHandle roomId="room-1" onOpen={vi.fn()} onDropCorner={vi.fn()} />,
      );
    });
    let handle = tree.root.findByProps({ testID: 'desktop-work-pane-handle' });
    act(() => handle.props.onHoverIn());
    handle = tree.root.findByProps({ testID: 'desktop-work-pane-handle' });
    expect(tree.root.findByProps({ testID: 'desktop-work-pane-tooltip' }).props.children).toBe(
      'Open work pane',
    );
    expect(renderedStyle(handle.props.style)).toMatchObject({
      backgroundColor: '#1e1326',
      borderTopColor: '#b08a4a',
      borderLeftColor: '#b08a4a',
      borderBottomColor: '#b08a4a',
    });
    act(() => handle.props.onHoverOut());
    expect(tree.root.findAllByProps({ testID: 'desktop-work-pane-tooltip' })).toHaveLength(0);
    expect(
      renderedStyle(
        tree.root.findByProps({ testID: 'desktop-work-pane-handle' }).props.style,
      ).backgroundColor,
    ).toBe('#190e21');
  });

  it('uses the hover treatment for keyboard focus', () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <DesktopWorkPaneHandle roomId="room-1" onOpen={vi.fn()} onDropCorner={vi.fn()} />,
      );
    });
    let handle = tree.root.findByProps({ testID: 'desktop-work-pane-handle' });
    act(() => handle.props.onFocus());
    handle = tree.root.findByProps({ testID: 'desktop-work-pane-handle' });
    expect(tree.root.findAllByProps({ testID: 'desktop-work-pane-tooltip' })).toHaveLength(0);
    expect(renderedStyle(handle.props.style)).toMatchObject({
      backgroundColor: '#1e1326',
      borderTopColor: '#b08a4a',
      borderLeftColor: '#b08a4a',
      borderBottomColor: '#b08a4a',
    });
    act(() => handle.props.onBlur());
    expect(
      renderedStyle(
        tree.root.findByProps({ testID: 'desktop-work-pane-handle' }).props.style,
      ).backgroundColor,
    ).toBe('#190e21');
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
    expect(
      renderedStyle(
        tree.root.findByProps({ testID: 'desktop-work-pane-handle' }).props.style,
      ),
    ).toMatchObject({ width: 150, backgroundColor: '#190e21' });
    expect(tree.root.findByType('Text' as any).props.children).toBe('DROP TO OPEN IN WORK PANE');
    act(() => dropTarget.props.onDrop(event));
    expect(onDropCorner).toHaveBeenCalledWith('corner-1');
    expect(tree.root.findByProps({ testID: 'desktop-work-pane-handle-glyph' })).toBeTruthy();
  });

  it('inscribes an arrived marker without opening anything on its own', () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <DesktopWorkPaneHandle
          arrived
          roomId="room-1"
          onOpen={vi.fn()}
          onDropCorner={vi.fn()}
        />,
      );
    });
    const handle = tree.root.findByProps({ testID: 'desktop-work-pane-handle' });
    expect(handle.props.accessibilityLabel).toBe('Open work pane, new corner');
    expect(tree.root.findByProps({ testID: 'desktop-work-pane-arrived' })).toBeTruthy();
    expect(renderedStyle(handle.props.style)).toMatchObject({
      backgroundColor: '#1e1326',
      borderTopColor: '#b08a4a',
      borderLeftColor: '#b08a4a',
      borderBottomColor: '#b08a4a',
    });
    expect(tree.root.findAllByProps({ testID: 'desktop-work-pane-tooltip' })).toHaveLength(0);
  });
});
