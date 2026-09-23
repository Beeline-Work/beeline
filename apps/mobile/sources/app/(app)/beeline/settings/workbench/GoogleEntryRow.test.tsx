import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'), View: host('View'), TouchableOpacity: host('TouchableOpacity'),
    Animated: { Value: (v: number) => ({ _value: v, add: () => ({ _value: v }),
      interpolate: () => ({ _value: v }) }), timing: () => ({ start: () => undefined }),
      sequence: () => ({ start: () => undefined }), loop: () => ({ start: () => undefined,
        stop: () => undefined }), View: host('Animated.View') },
  };
});
vi.mock('@/components/buzz/SettingsRow', async () => {
  const ReactModule = await import('react');
  return { SettingsRow: (props: any) => ReactModule.createElement('SettingsRow', props) };
});

import { GoogleEntryRow } from './GoogleEntryRow';
import type { WorkbenchConnector } from '@/buzz/workbench';

const originalConsoleError = console.error;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

it('shows four independent Google install actions and statuses', async () => {
  const onPressConnect = vi.fn();
  const connectors: WorkbenchConnector[] = [
    { id: 'google-gmail', name: 'Gmail', description: 'Mail', available: true, status: 'connected' },
    { id: 'google-calendar', name: 'Calendar', description: 'Events', available: true },
    { id: 'google-drive', name: 'Drive', description: 'Files', available: true, status: 'installing' },
    { id: 'google-youtube', name: 'YouTube', description: 'Videos', available: true,
      status: 'error', errorMessage: 'Scope refused' },
  ];
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<GoogleEntryRow connectors={connectors}
    onPressConnect={onPressConnect} />); });
  const parent = renderer.root.findByProps({ testID: 'google-entry-row' });
  expect(parent.props.action).toBeUndefined();
  await act(async () => parent.props.onPress());
  expect(renderer.root.findByProps({ testID: 'google-tool-google-gmail' }).props.value).toBe('connected');
  expect(renderer.root.findByProps({ testID: 'google-tool-google-drive' }).props.value).toBe('installing');
  expect(renderer.root.findByProps({ testID: 'google-tool-google-youtube' }).props.description).toBe('Scope refused');
  await act(async () => renderer.root.findByProps({
    testID: 'google-tool-google-calendar',
  }).props.trailingPress.onPress());
  expect(onPressConnect).toHaveBeenCalledWith('google-calendar');
  await act(async () => renderer.unmount());
});
