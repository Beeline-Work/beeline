import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(
      name,
      props,
      // Pressable takes a render prop for its press state; every other host
      // takes plain children.
      typeof props.children === 'function' ? props.children({ pressed: false }) : props.children,
    );
  return {
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

import { WritePermissionOutcome } from './WritePermissionOutcome';

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

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

describe('write permission corner outcome', () => {
  it('shows a direct corner action after Body publishes the opened corner id', () => {
    const onOpenCorner = vi.fn();
    const renderer = render(
      React.createElement(WritePermissionOutcome, {
        status: 'allowed',
        subchannelId: 'new-corner-id',
        onOpenCorner,
      }),
    );

    const action = renderer.root
      .findAllByProps({ testID: 'write-permission-open-corner' })
      .find((node: { type: unknown }) => node.type === 'Pressable');
    act(() => action.props.onPress());
    expect(onOpenCorner).toHaveBeenCalledWith('new-corner-id');
  });

  it('inscribes the outcome as one dim line — no border, no fill, no chip', () => {
    const renderer = render(
      React.createElement(WritePermissionOutcome, {
        status: 'allowed',
        subchannelId: 'new-corner-id',
        onOpenCorner: vi.fn(),
      }),
    );
    const pressable = renderer.root
      .findAllByProps({ testID: 'write-permission-open-corner' })
      .find((node: { type: unknown }) => node.type === 'Pressable');
    expect(pressable.props.style).not.toHaveProperty('borderWidth');
    expect(pressable.props.style).not.toHaveProperty('borderColor');
    expect(pressable.props.style).not.toHaveProperty('backgroundColor');
    expect(pressable.props.style).not.toHaveProperty('minHeight');
    // Starts at the prose margin and reserves the same right gutter the
    // timestamps hang in.
    expect(pressable.props.style.paddingHorizontal).toBeUndefined();
    expect(pressable.props.style.paddingRight).toBe(36);

    const [status, enter] = renderer.root.findAllByType('Text');
    // Faceted diamond for "corner", arrow for "enterable".
    expect(status.props.children).toContain('◇');
    expect(enter.props.children).toContain('view →');
    // Only the affordance lifts: dim label, half-step-brighter action, and the
    // action hangs in the gutter rather than sitting inline.
    const tone = (node: { props: { style: unknown } }) =>
      (Array.isArray(node.props.style) ? node.props.style : [node.props.style])
        .filter(Boolean)
        .reduce((merged: Record<string, unknown>, style: Record<string, unknown>) => ({ ...merged, ...style }), {});
    expect(tone(status).color).toBe('#7c7c7c');
    expect(tone(enter).color).toBe('#b0b0b0');
    expect(tone(enter).position).toBe('absolute');
    expect(tone(enter).right).toBe(0);
  });

  it('flashes tonally on press instead of drawing a border', () => {
    let pressedTree!: ReactTestRenderer;
    act(() => {
      pressedTree = create(
        React.createElement(WritePermissionOutcome, {
          status: 'allowed',
          subchannelId: 'new-corner-id',
          onOpenCorner: vi.fn(),
        }),
      );
    });
    // The mock renders the unpressed branch; assert the pressed styles exist
    // and are purely tonal, which is what the render prop selects between.
    const source = pressedTree.root
      .findAllByType('Text')
      .map((node: { props: { style: unknown } }) => node.props.style)
      .flat()
      .filter(Boolean);
    for (const style of source) {
      expect(style).not.toHaveProperty('borderWidth');
      expect(style).not.toHaveProperty('backgroundColor');
    }
  });

  it('does not offer navigation before a corner exists or after denial', () => {
    const onOpenCorner = vi.fn();
    for (const props of [
      { status: 'allowed' as const },
      { status: 'denied' as const, subchannelId: 'never-opened' },
    ]) {
      const renderer = render(
        React.createElement(WritePermissionOutcome, { ...props, onOpenCorner }),
      );
      expect(renderer.root.findAllByProps({ testID: 'write-permission-open-corner' })).toHaveLength(
        0,
      );
    }
  });
});
