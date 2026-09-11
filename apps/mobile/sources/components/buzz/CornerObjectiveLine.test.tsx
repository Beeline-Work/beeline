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
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: (theme: unknown) => unknown) =>
      factory({
        buzz: {
          humanRail: '#b08a4a',
          textSecondary: '#c9c9d1',
          proseRegular: 'SpaceGrotesk-Regular',
        },
      }),
  },
}));

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
});
