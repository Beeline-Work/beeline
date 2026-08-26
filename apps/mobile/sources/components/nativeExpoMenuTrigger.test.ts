import * as React from 'react';
import { readFileSync } from 'node:fs';
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

import { NativeOptionsPicker } from './NativeOptionsPicker.ios';
import { NativeSettingsMenu } from './NativeSettingsMenu.ios';

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

describe('iOS Hull menu adapters', () => {
  it('maps an options picker to the shared sheet while preserving selection and callbacks', () => {
    const onSelect = vi.fn();
    const renderer = render(
      React.createElement(NativeOptionsPicker, {
        title: 'Machine',
        triggerLabel: 'Mac',
        options: [
          { key: 'mac', label: 'Mac' },
          { key: 'mini', label: 'Mini' },
        ],
        selectedKey: 'mac',
        onSelect,
        children: React.createElement('Trigger'),
      }),
    );

    const trigger = renderer.root.findByType('HullMenuTrigger' as any);
    expect(trigger.props).toMatchObject({
      accessibilityLabel: 'Machine',
      testID: 'hull-options-picker-trigger',
      title: 'Machine',
    });
    const actions = trigger.props.sections[0].actions;
    expect(
      actions.map((action: any) => ({ label: action.label, selected: action.selected })),
    ).toEqual([
      { label: 'Mac', selected: true },
      { label: 'Mini', selected: false },
    ]);

    act(() => actions[1].onPress());
    expect(onSelect).toHaveBeenCalledWith('mini');
  });

  it('uses the same Hull adapter on iOS and Android with no Expo system-menu chrome', () => {
    const settings = render(
      React.createElement(NativeSettingsMenu, {
        groups: [
          {
            key: 'model',
            label: 'Opus',
            options: [{ key: 'opus', label: 'Opus' }],
            selectedKey: 'opus',
            onSelect: vi.fn(),
          },
        ],
        children: React.createElement('Trigger'),
      }),
    );
    expect(settings.root.findByType('HullMenuTrigger' as any)).toBeDefined();

    for (const file of [
      './NativeOptionsPicker.ios.tsx',
      './NativeOptionsPicker.android.tsx',
      './NativeSettingsMenu.ios.tsx',
      './NativeSettingsMenu.android.tsx',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).toMatch(/\.hull/);
      expect(source).not.toContain('@expo/ui');
    }
  });
});
