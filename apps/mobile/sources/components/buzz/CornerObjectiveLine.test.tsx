import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', async () => {
  const { typeRoles } = await import('@/buzz/groknight');
  return {
    StyleSheet: {
      hairlineWidth: 1,
      create: (factory: (theme: unknown) => unknown) =>
        factory({
          buzz: {
            humanRail: '#b08a4a',
            accent: '#c49a52',
            textSecondary: '#c9c9d1',
            proseRegular: 'SpaceGrotesk-Regular',
            type: typeRoles,
          },
        }),
    },
  };
});

import { CornerObjectiveLine } from './CornerObjectiveLine';

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

describe('CornerObjectiveLine', () => {
  it('inscribes the full objective as prose on a brass rail — no clamp, box, or control', () => {
    const objective =
      'Restore the complete corner objective across every line so a long but valid request remains readable in its entirety.';
    const renderer = render(<CornerObjectiveLine objective={objective} />);
    const copy = renderer.root.findByProps({ testID: 'corner-objective-line-copy' });
    expect(copy.props.children).toBe(objective);
    expect(copy.props.style.color).toBe('#c9c9d1');
    expect(copy.props.style.fontFamily).toBe('SpaceGrotesk-Regular');
    expect(copy.props.numberOfLines).toBeUndefined();
    expect(copy.props.ellipsizeMode).toBeUndefined();

    const line = renderer.root.findByProps({ testID: 'corner-objective-line' });
    expect(line.props.style.borderWidth).toBeUndefined();
    expect(line.props.style.backgroundColor).toBeUndefined();
    const rail = renderer.root
      .findAllByType('View' as any)
      .find((node: any) => node.props.style?.backgroundColor === '#b08a4a');
    expect(rail).toBeDefined();
    expect(rail.props.style.width).toBe(2);

    expect(
      renderer.root
        .findAllByProps({ accessibilityRole: 'button' })
        .filter((node: any) => typeof node.type === 'string'),
    ).toHaveLength(0);
    expect(renderer.root.findAllByType('Pressable' as any)).toHaveLength(0);
  });

  it('renders nothing rather than a placeholder when there is no objective', () => {
    expect(render(<CornerObjectiveLine />).toJSON()).toBeNull();
    expect(render(<CornerObjectiveLine objective="   " />).toJSON()).toBeNull();
  });

  it('hangs a Brief link in the gutter only when the corner has a brief', () => {
    const onOpenBrief = vi.fn();
    const renderer = render(<CornerObjectiveLine objective="Ship it" onOpenBrief={onOpenBrief} />);
    const link = renderer.root
      .findAllByType('Pressable' as any)
      .find((node: any) => node.props.testID === 'corner-objective-line-brief');
    expect(link.props.accessibilityRole).toBe('link');
    expect(link.props.accessibilityLabel).toBe('Open brief');
    const style = link.props.style({ pressed: false }).find(Boolean);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    expect(link.findByType('Text' as any).props.children).toBe('Brief');
    expect(link.findByType('Text' as any).props.style.color).toBe('#c49a52');
    act(() => link.props.onPress());
    expect(onOpenBrief).toHaveBeenCalledTimes(1);

    expect(
      render(<CornerObjectiveLine objective="Ship it" />).root.findAllByType('Pressable' as any),
    ).toHaveLength(0);
  });
});
