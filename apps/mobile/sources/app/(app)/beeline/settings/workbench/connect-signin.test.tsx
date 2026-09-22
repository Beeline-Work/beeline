import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const searchParams = vi.hoisted(() => ({
  workspaceId: 'workspace-1',
  connectorId: 'connector-row-1',
  connectorName: 'Tailscale',
  url: 'https://login.tailscale.com/a/test',
  method: 'oauth',
}));

vi.mock('expo-router', () => ({
  router: { back: vi.fn(), replace: vi.fn() },
  useLocalSearchParams: () => searchParams,
}));

vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
  openBrowserAsync: vi.fn(),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    ActivityIndicator: host('ActivityIndicator'),
    Platform: { OS: 'web', select: (choices: Record<string, unknown>) => choices.default },
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('@/components/AnimatedOverlay', async () => {
  const ReactModule = await import('react');
  return {
    AnimatedBlurBackdrop: (props: any) => ReactModule.createElement('AnimatedBlurBackdrop', props),
  };
});

vi.mock('@/components/buzz/sandbox-webview', async () => {
  const ReactModule = await import('react');
  return { useSandboxWebView: () => (props: any) => ReactModule.createElement('WebView', props) };
});

vi.mock('@/buzz/workbench-source', () => ({
  getWorkbenchSource: () => ({ readInstallState: vi.fn(async () => null) }),
}));

import ConnectorSignInScreen from './connect-signin';

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

describe('ConnectorSignInScreen', () => {
  it('names the connector being authenticated', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(ConnectorSignInScreen));
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ testID: 'signin-title' }).props.children).toEqual([
      'Sign in to ',
      'Tailscale',
    ]);
    await act(async () => renderer.unmount());
  });
});
