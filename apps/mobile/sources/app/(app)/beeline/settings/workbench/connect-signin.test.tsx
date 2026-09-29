import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const storedReturn = vi.hoisted(() => new Map<string, string>());
const appStateListeners = vi.hoisted(() => new Set<(state: string) => void>());

const searchParams = vi.hoisted(() => ({
  workspaceId: 'workspace-1',
  connectorId: 'connector-row-1',
  connectorName: 'Tailscale',
  machineName: 'squire-box',
  url: 'https://login.tailscale.com/a/test',
  method: 'oauth',
  oauthReturn: undefined as string | undefined,
  appSignInSession: undefined as string | undefined,
}));
const readInstallState = vi.hoisted(() => vi.fn(async () => null as null | {
  connected: boolean;
  steps?: { label: string; status: string }[];
  signIn?: { method: 'oauth' | 'streamed'; url: string } | null;
}));
const cancelGoogleSignIn = vi.hoisted(() => vi.fn(async () => true));
const completeAppSignIn = vi.hoisted(() => vi.fn(async () => ({ appId: 'app-slack' })));

vi.mock('expo-router', () => ({
  router: { back: vi.fn(), replace: vi.fn() },
  useLocalSearchParams: () => searchParams,
}));

vi.mock('expo-web-browser', () => ({
  WebBrowserResultType: { CANCEL: 'cancel', DISMISS: 'dismiss' },
  openAuthSessionAsync: vi.fn(async (): Promise<any> => new Promise(() => undefined)),
  openBrowserAsync: vi.fn(),
  dismissAuthSession: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => storedReturn.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { storedReturn.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { storedReturn.delete(key); }),
} }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    ActivityIndicator: host('ActivityIndicator'),
    AppState: { addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    } },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.android },
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

vi.mock('@/components/buzz/PageHeader', async () => {
  const ReactModule = await import('react');
  return {
    PageHeader: (props: any) => ReactModule.createElement('PageHeader', props),
  };
});

vi.mock('@/components/buzz/sandbox-webview', async () => {
  const ReactModule = await import('react');
  return { useSandboxWebView: () => (props: any) => ReactModule.createElement('WebView', props) };
});

vi.mock('@/buzz/workbench-source', () => ({
  getWorkbenchSource: () => ({ readInstallState, cancelGoogleSignIn, completeAppSignIn }),
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

afterEach(() => {
  searchParams.connectorName = 'Tailscale';
  searchParams.url = 'https://login.tailscale.com/a/test';
  searchParams.oauthReturn = undefined;
  searchParams.appSignInSession = undefined;
  completeAppSignIn.mockReset().mockResolvedValue({ appId: 'app-slack' });
  readInstallState.mockReset().mockResolvedValue(null);
  cancelGoogleSignIn.mockReset().mockResolvedValue(true);
  vi.mocked(WebBrowser.openAuthSessionAsync).mockReset()
    .mockImplementation(async () => new Promise(() => undefined));
  vi.mocked(WebBrowser.openBrowserAsync).mockClear();
  vi.mocked(WebBrowser.dismissAuthSession).mockClear();
  vi.mocked(router.back).mockClear();
  vi.mocked(router.replace).mockClear();
  storedReturn.clear();
});

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
    readInstallState.mockImplementation(async () => ({
      connected: row.status === 'connected', steps: [],
      signIn: row.signIn ? { method: searchParams.method as 'streamed', url: row.signIn.url } : null,
    }));
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

  it('redeems a provider callback once and returns to the original Room', async () => {
    searchParams.appSignInSession = 'https://provider.test/session/one';
    storedReturn.set('beeline.app-sign-in-return.v1', JSON.stringify({ workspaceId: 'workspace-1', viewerId: 'human-1', roomId: 'room-1' }));
    await act(async () => { create(React.createElement(ConnectorSignInScreen)); await Promise.resolve(); });
    expect(completeAppSignIn).toHaveBeenCalledWith({ sessionUri: searchParams.appSignInSession });
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/beeline/chat/[channelId]', params: { channelId: 'room-1' } });
    expect(storedReturn.size).toBe(0);
  });

  it('returns a Workbench connection to Workbench only after verified completion', async () => {
    searchParams.appSignInSession = 'https://provider.test/session/two';
    storedReturn.set('beeline.app-sign-in-return.v1', JSON.stringify({ workspaceId: 'workspace-1', viewerId: 'human-1' }));
    await act(async () => { create(React.createElement(ConnectorSignInScreen)); await Promise.resolve(); });
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/beeline/settings/workbench', params: { workspaceId: 'workspace-1', viewerId: 'human-1' } });
  });

  it('keeps a failed verifier on the callback screen and does not claim success', async () => {
    searchParams.appSignInSession = 'https://provider.test/session/denied';
    completeAppSignIn.mockRejectedValueOnce(new Error('Sign-in was denied'));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); await Promise.resolve(); });
    expect(JSON.stringify(renderer.toJSON())).toContain('Sign-in was denied');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('keeps an ordinary helper sign-in in the existing Workbench overlay', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
    expect(renderer.root.findByProps({ testID: 'signin-header' }).props.title).toBe('Sign in to Tailscale');
  });
});
