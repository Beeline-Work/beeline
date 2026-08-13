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

    const action = renderer.root.findByProps({ testID: 'write-permission-open-corner' });
    act(() => action.props.onPress());
    expect(onOpenCorner).toHaveBeenCalledWith('new-corner-id');
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
