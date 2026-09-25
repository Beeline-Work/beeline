import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const searchParams = vi.hoisted(() => ({
  workspaceId: 'workspace-1',
  connectorId: 'connector-row-1',
  connectorName: 'Tailscale',
  machineName: 'squire-box',
  url: 'https://login.tailscale.com/a/test',
  method: 'oauth',
}));
const readInstallState = vi.hoisted(() => vi.fn(async () => null as null | {
  connected: boolean;
  signIn?: { method: 'oauth'; url: string };
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
  getWorkbenchSource: () => ({ readInstallState }),
}));

import ConnectorSignInScreen from './connect-signin';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';

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
  it('carries a Squire ceremony through connector state to sign-in dismissal', async () => {
    // Load the helper implementation at runtime so the isolated mobile
    // typecheck does not compile the helper's host-only dependency graph.
    const bodyRoot = '../../../../../../../body/src/';
    const { ConnectorAssignmentLoop } = await vi.importActual<any>(bodyRoot + 'connector-assignments.ts');
    const { installSquire } = await vi.importActual<any>(bodyRoot + 'connector-squire.ts');
    const noVncUrl = 'https://tunnel.test/#p=secret';
    const row: { status: 'installing' | 'connected'; signIn: { url: string } | null } = {
      status: 'installing', signIn: null,
    };
    const operations: string[] = [];
    let claimed = false;
    const api = {
      async execute(op: string, input: Record<string, unknown>) {
        operations.push(`${op} ${String(input.errorMessage ?? JSON.stringify(input.signIn ?? input.steps ?? ''))}`);
        if (op === 'getConnectorAssignments') {
          return { assignments: [{ kind: 'install', connectorId: 'connector-row-1', connectorType: 'trusty-squire' }] };
        }
        if (op === 'postConnectorStatus') {
          row.signIn = (input.signIn as { url: string } | null | undefined) ?? row.signIn;
          return {};
        }
        if (op === 'installConnector') {
          row.status = 'connected';
          row.signIn = null;
          return {};
        }
        if (op === 'postConnectorVault') return {};
        throw new Error(`unexpected operation: ${op}`);
      },
    };
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'helper-1',
      log: (message: string) => operations.push(`log: ${message}`),
      readVault: async () => [],
      install: (options: { [key: string]: unknown }) => installSquire({
        ...options,
        mcp: { async call() { return { credentials: [] }; } },
        run: async () => ({ code: 0, stdout: '1.1.17', stderr: '' }),
        streamRun: async () => ({
          stdout: '', stderr: '', abort: () => {},
          report: claimed
            ? { state: 'connected', terminal: true, sign_in_url: null, browser_location: { kind: 'none' } }
            : {
                state: 'needs-sign-in', terminal: false,
                sign_in_url: 'https://trustysquire.ai/install?token=secret',
                browser_location: { kind: 'virtual', url: noVncUrl },
              },
        } as never),
      }),
    });
    readInstallState.mockImplementation(async () => ({ connected: row.status === 'connected' }));
    searchParams.method = 'streamed-page';
    searchParams.url = noVncUrl;
    let renderer: ReactTestRenderer | undefined;
    try {
      await loop.runOnce();
      await vi.waitFor(() => expect(row.signIn?.url).toBe(noVncUrl));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
      expect(renderer!.root.findByProps({ testID: 'signin-webview' }).props.source.uri).toBe(row.signIn?.url);
      expect(row.status).toBe('installing');
      await vi.waitFor(() => expect(readInstallState).toHaveBeenCalled(), { timeout: 2500 });
      expect(router.replace).not.toHaveBeenCalled();

      claimed = true;
      await loop.runOnce();
      await vi.waitFor(() => expect(row.status, operations.join('\n')).toBe('connected'));
      expect(operations.some((operation) => operation.startsWith('installConnector'))).toBe(true);
      await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1), { timeout: 2500 });
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      loop.stop();
      vi.mocked(router.replace).mockClear();
      readInstallState.mockReset();
      searchParams.method = 'oauth';
      searchParams.url = 'https://login.tailscale.com/a/test';
    }
  }, 10_000);

  it('dismisses the noVNC sign-in overlay when the helper settles connected', async () => {
    searchParams.method = 'streamed-page';
    searchParams.url = 'https://tunnel.test/#p=secret';
    readInstallState.mockResolvedValue({ connected: true });
    vi.useFakeTimers();
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
      expect(renderer.root.findByProps({ testID: 'signin-webview' }).props.source.uri).toBe(searchParams.url);
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(readInstallState).toHaveBeenCalledWith({
        workspaceId: 'workspace-1', connectorId: 'connector-row-1',
      });
      expect(router.replace).toHaveBeenCalledTimes(1);
      await act(async () => renderer.unmount());
    } finally {
      vi.useRealTimers();
      vi.mocked(router.replace).mockClear();
      readInstallState.mockReset();
      searchParams.method = 'oauth';
      searchParams.url = 'https://login.tailscale.com/a/test';
    }
  });

  it('opens Google OAuth in the system browser', async () => {
    searchParams.connectorName = 'Google Workspace';
    searchParams.url = 'https://accounts.google.com/o/oauth2/v2/auth?state=test';
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
    expect(renderer.root.findAllByType('WebView')).toHaveLength(0);
    await act(async () => renderer.root.findByProps({ testID: 'signin-open-external' }).props.onPress());
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(searchParams.url);
    await act(async () => renderer.unmount());
    searchParams.connectorName = 'Tailscale';
    searchParams.url = 'https://login.tailscale.com/a/test';
  });

  it('switches to the next Composio toolkit link while the overlay stays open', async () => {
    searchParams.connectorName = 'Composio';
    searchParams.url = 'https://app.composio.dev/link/first';
    readInstallState.mockResolvedValue({
      connected: false,
      signIn: { method: 'oauth', url: 'https://app.composio.dev/link/second' },
    });
    vi.useFakeTimers();
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(renderer.root.findByProps({ testID: 'signin-oauth-browser' })).toBeTruthy();
      await act(async () => renderer.root.findByProps({ testID: 'signin-open-external' }).props.onPress());
      expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://app.composio.dev/link/second');
      expect(router.replace).not.toHaveBeenCalled();
      await act(async () => renderer.unmount());
    } finally {
      vi.useRealTimers();
      readInstallState.mockReset();
      vi.mocked(WebBrowser.openBrowserAsync).mockClear();
      searchParams.connectorName = 'Tailscale';
      searchParams.url = 'https://login.tailscale.com/a/test';
    }
  });

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
    expect(renderer.root.findByProps({ testID: 'signin-machine' }).props.children)
      .toBe('squire-box');
    await act(async () => renderer.unmount());
  });
});
