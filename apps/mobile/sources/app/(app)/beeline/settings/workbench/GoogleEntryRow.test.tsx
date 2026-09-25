import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example.test' }),
}));
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/components/buzz/ServiceMark', async () => {
  const ReactModule = await import('react');
  return { ServiceMark: (props: any) => ReactModule.createElement('ServiceMark', props) };
});

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
  const onPressDisconnect = vi.fn();
  const connectors: WorkbenchConnector[] = [
    { id: 'google-gmail', name: 'Gmail', description: 'Mail', available: true, status: 'connected' },
    { id: 'google-calendar', name: 'Calendar', description: 'Events', available: true },
    { id: 'google-drive', name: 'Drive', description: 'Files', available: true, status: 'installing' },
    { id: 'google-youtube', name: 'YouTube', description: 'Videos', available: true,
      status: 'error', errorMessage: 'Scope refused' },
  ];
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<GoogleEntryRow connectors={connectors}
    onPressConnect={onPressConnect} onPressDisconnect={onPressDisconnect} />); });
  const parent = renderer.root.findByProps({ testID: 'google-entry-row' });
  expect(parent.props.leading.props.company).toBe('google');
  expect(parent.props.leading.props.domain).toBe('google.com');
  expect(parent.props.leading.props.testID).toBe('google-entry-mark');
  expect(parent.props.value).toBe('installing');
  expect(parent.props.action).toBeUndefined();
  await act(async () => parent.props.onPress());
  expect(renderer.root.findByProps({ testID: 'google-tool-google-gmail' }).props.value).toBe('connected');
  expect(renderer.root.findByProps({ testID: 'google-tool-google-drive' }).props.leading.props.avatarUrl)
    .toBe('https://server.example.test/v1/connectors/logo/google-drive.svg');
  expect(renderer.root.findByProps({ testID: 'google-tool-google-drive' }).props.value).toBe('installing');
  expect(renderer.root.findByProps({ testID: 'google-tool-google-youtube' }).props.description).toBe('Scope refused');
  expect(renderer.root.findByProps({ testID: 'google-tool-google-youtube-reconnect' }).props.title).toBe('Reconnect');
  expect(renderer.root.findByProps({ testID: 'google-tool-google-youtube-disconnect' }).props.title).toBe('Disconnect');
  await act(async () => renderer.root.findByProps({
    testID: 'google-tool-google-youtube-disconnect',
  }).props.onPress());
  expect(onPressDisconnect).toHaveBeenCalledWith('google-youtube');
  await act(async () => renderer.root.findByProps({
    testID: 'google-tool-google-calendar',
  }).props.trailingPress.onPress());
  expect(onPressConnect).toHaveBeenCalledWith('google-calendar');
  await act(async () => renderer.unmount());
});

it('shows Connect on the parent when no Google tool is connected', async () => {
  const onPressConnect = vi.fn();
  const connectors: WorkbenchConnector[] = [
    { id: 'google-gmail', name: 'Gmail', description: 'Mail', available: true },
    { id: 'google-calendar', name: 'Calendar', description: 'Events', available: true },
    { id: 'google-drive', name: 'Drive', description: 'Files', available: true },
    { id: 'google-youtube', name: 'YouTube', description: 'Videos', available: true },
  ];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <GoogleEntryRow
        connectors={connectors}
        onPressConnect={onPressConnect}
        onPressDisconnect={vi.fn()}
      />,
    );
  });
  const parent = renderer.root.findByProps({ testID: 'google-entry-row' });
  expect(parent.props.action).toBe('Connect');
  expect(parent.props.trailingPress.testID).toBe('google-entry-connect');
  await act(async () => parent.props.trailingPress.onPress());
  expect(onPressConnect).toHaveBeenCalledWith('google');
  await act(async () => renderer.unmount());
});

it('shows connected on the parent when every Google tool is connected', async () => {
  const connectors: WorkbenchConnector[] = [
    { id: 'google-gmail', name: 'Gmail', description: 'Mail', available: true, status: 'connected' },
    { id: 'google-calendar', name: 'Calendar', description: 'Events', available: true, status: 'connected' },
    { id: 'google-drive', name: 'Drive', description: 'Files', available: true, status: 'connected' },
    { id: 'google-youtube', name: 'YouTube', description: 'Videos', available: true, status: 'connected' },
  ];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <GoogleEntryRow
        connectors={connectors}
        onPressConnect={vi.fn()}
        onPressDisconnect={vi.fn()}
      />,
    );
  });
  const parent = renderer.root.findByProps({ testID: 'google-entry-row' });
  expect(parent.props.value).toBe('connected');
  expect(parent.props.action).toBeUndefined();
  expect(parent.props.trailingPress).toBeUndefined();
  await act(async () => renderer.unmount());
});

it('offers YouTube reconnect and disconnect from the adapter while connected', async () => {
  const onPressConnect = vi.fn();
  const onPressDisconnect = vi.fn();
  const connectors: WorkbenchConnector[] = [
    { id: 'google-gmail', name: 'Gmail', description: 'Mail', available: true, status: 'connected' },
    { id: 'google-calendar', name: 'Calendar', description: 'Events', available: true, status: 'connected' },
    { id: 'google-drive', name: 'Drive', description: 'Files', available: true, status: 'connected' },
    { id: 'google-youtube', name: 'YouTube', description: 'Videos', available: true, status: 'connected' },
  ];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <GoogleEntryRow
        connectors={connectors}
        onPressConnect={onPressConnect}
        onPressDisconnect={onPressDisconnect}
      />,
    );
  });
  await act(async () => renderer.root.findByProps({ testID: 'google-entry-row' }).props.onPress());
  expect(renderer.root.findByProps({ testID: 'google-tool-google-youtube' }).props.value).toBe(
    'connected',
  );
  expect(renderer.root.findAllByProps({ testID: 'google-tool-google-gmail-reconnect' })).toHaveLength(
    0,
  );
  expect(renderer.root.findByProps({ testID: 'google-tool-google-youtube-reconnect' }).props.title).toBe(
    'Reconnect',
  );
  expect(
    renderer.root.findByProps({ testID: 'google-tool-google-youtube-disconnect' }).props.title,
  ).toBe('Disconnect');
  await act(async () => renderer.unmount());
});
