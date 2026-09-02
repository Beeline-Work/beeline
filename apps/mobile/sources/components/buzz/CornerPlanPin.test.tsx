import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

import { CornerPlanPin } from './CornerPlanPin';

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

describe('CornerPlanPin', () => {
  it('renders nothing without the fixed objective', () => {
    expect(render(<CornerPlanPin />).toJSON()).toBeNull();
  });

  it('renders only the fixed objective and no mutable checklist', () => {
    const renderer = render(<CornerPlanPin objective="Add color to code blocks" />);
    expect(
      renderer.root.findAllByType('Text').map((node: ReactTestInstance) => node.props.children),
    ).toEqual(['OBJECTIVE', 'Add color to code blocks']);
    expect(renderer.root.findAllByType('ScrollView')).toHaveLength(0);
  });

  it('expands the complete objective when pressed and collapses it again', () => {
    const objective = `Preserve this complete objective ${'with all of its detail '.repeat(20)}`;
    const renderer = render(<CornerPlanPin objective={objective} testID="objective" />);
    const toggle = renderer.root.findByProps({ testID: 'objective-objective-toggle' });
    const text = () => renderer.root.findByProps({ testID: 'objective-objective' });

    expect(text().props.numberOfLines).toBe(2);
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
    act(() => toggle.props.onPress());
    expect(text().props.numberOfLines).toBeUndefined();
    expect(toggle.props.accessibilityState).toEqual({ expanded: true });
    act(() => toggle.props.onPress());
    expect(text().props.numberOfLines).toBe(2);
  });
});
