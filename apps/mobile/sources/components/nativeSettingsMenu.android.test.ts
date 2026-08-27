import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/buzz/HullMenuTrigger', async () => {
  const ReactModule = await import('react');
  return {
    HullMenuTrigger: (props: any) =>
      ReactModule.createElement('HullMenuTrigger', props, props.children),
  };
});

import { NativeSettingsMenu } from './NativeSettingsMenu.android';

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

describe('Android Hull settings menu', () => {
  it('maps grouped options into one bottom-sheet trigger and preserves disabled selection state', () => {
    const onSelect = vi.fn();
    const renderer = render(
      React.createElement(NativeSettingsMenu, {
        accessibilityLabel: 'Model settings',
        groups: [
          {
            key: 'model',
            label: 'Ready',
            title: 'Model',
            selectedKey: 'ready',
            options: [
              { key: 'ready', label: 'Ready' },
              { key: 'unavailable', label: 'Unavailable', disabled: true },
            ],
            onSelect,
          },
        ],
        children: React.createElement('Trigger'),
      }),
    );

    const trigger = renderer.root.findByType('HullMenuTrigger' as any);
    expect(trigger.props).toMatchObject({
      accessibilityLabel: 'Model settings',
      testID: 'hull-settings-menu-trigger',
    });
    const actions = trigger.props.sections[0].actions;
    expect(actions[0]).toMatchObject({ label: 'Ready', metadata: 'Model', selected: true });
    expect(actions[1]).toMatchObject({ label: 'Unavailable', disabled: true, selected: false });

    act(() => actions[0].onPress());
    expect(onSelect).toHaveBeenCalledWith('ready');
  });
});
