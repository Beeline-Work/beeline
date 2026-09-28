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
}));
const readInstallState = vi.hoisted(() => vi.fn(async () => null as null | {
  connected: boolean;
  signIn?: { method: 'oauth'; url: string };
}));
const cancelGoogleSignIn = vi.hoisted(() => vi.fn(async () => true));

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
  getWorkbenchSource: () => ({ readInstallState, cancelGoogleSignIn }),
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

  it('opens Google in an Android auth session with the app return URI', async () => {
    searchParams.connectorName = 'Google Workspace';
    searchParams.url = 'https://accounts.google.com/o/oauth2/v2/auth?state=test';
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
    expect(renderer.root.findAllByType('WebView')).toHaveLength(0);
    expect(renderer.root.findAllByType('Text').some((node: any) =>
      String(node.props.children).includes('Choose Advanced, then Go to Beeline'))).toBe(true);
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(searchParams.url,
      'beeline://beeline/settings/workbench/connect-signin',
      { preferUniversalLinks: false, createTask: true, useProxyActivity: false });
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
    expect(JSON.parse(storedReturn.get('beeline.google-auth-return.v1')!)).toMatchObject({ state: 'test' });
    await act(async () => renderer.unmount());
  });

  it.each(['cancel', 'dismiss'])('retires the attempt on auth-session %s', async (type) => {
    searchParams.url = 'https://accounts.google.com/o/oauth2/v2/auth?state=cancelled';
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({ type } as never);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
    expect(cancelGoogleSignIn).toHaveBeenCalledWith({ connectorId: 'connector-row-1', state: 'cancelled' });
    expect(WebBrowser.dismissAuthSession).toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith('/beeline/settings/workbench');
    expect(storedReturn.size).toBe(0);
    await act(async () => renderer.unmount());
  });

  it('shows Beeline and retires the attempt after backgrounding mid-sign-in', async () => {
    searchParams.url = 'https://accounts.google.com/o/oauth2/v2/auth?state=backgrounded';
    readInstallState.mockResolvedValue({ connected: false,
      signIn: { method: 'oauth', url: searchParams.url } });
    let finish!: (result: { type: string }) => void;
    vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }) as never);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
    await act(async () => {
      for (const listener of appStateListeners) listener('background');
      for (const listener of appStateListeners) listener('active');
      await Promise.resolve();
    });
    expect(cancelGoogleSignIn).not.toHaveBeenCalled();
    await act(async () => { finish({ type: 'dismiss' }); });
    expect(cancelGoogleSignIn).toHaveBeenCalledWith({ connectorId: 'connector-row-1',
      state: 'backgrounded' });
    expect(router.replace).toHaveBeenCalledWith('/beeline/settings/workbench');
    await act(async () => renderer.unmount());
  });

  it('keeps the Room return when Android reports dismiss before the callback link', async () => {
    searchParams.url = 'https://accounts.google.com/o/oauth2/v2/auth?state=race';
    (searchParams as typeof searchParams & { roomId?: string }).roomId = 'room-race';
    cancelGoogleSignIn.mockResolvedValueOnce(false);
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({ type: 'dismiss' } as never);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
    expect(storedReturn.get('beeline.google-auth-return.v1')).toContain('room-race');
    await act(async () => renderer.unmount());
    vi.mocked(router.replace).mockClear();
    searchParams.oauthReturn = 'race';
    searchParams.url = '';
    await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'room-race' } });
    await act(async () => renderer.unmount());
    delete (searchParams as typeof searchParams & { roomId?: string }).roomId;
  });

  it('returns to the Room on a successful Google redirect', async () => {
    searchParams.url = 'https://accounts.google.com/o/oauth2/v2/auth?state=completed';
    (searchParams as typeof searchParams & { roomId?: string }).roomId = 'room-1';
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({ type: 'success',
      url: 'beeline://beeline/settings/workbench/connect-signin?oauthReturn=completed' } as never);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
    expect(cancelGoogleSignIn).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'room-1' } });
    await act(async () => renderer.unmount());
    delete (searchParams as typeof searchParams & { roomId?: string }).roomId;
  });

  it('retires a failed session and a manual back without leaving the browser live', async () => {
    searchParams.url = 'https://accounts.google.com/o/oauth2/v2/auth?state=failed';
    vi.mocked(WebBrowser.openAuthSessionAsync).mockRejectedValueOnce(new Error('browser unavailable'));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
    expect(cancelGoogleSignIn).toHaveBeenCalledWith({ connectorId: 'connector-row-1', state: 'failed' });
    expect(router.replace).toHaveBeenCalled();
    expect(storedReturn.size).toBe(0);
    await act(async () => renderer.unmount());

    vi.mocked(router.replace).mockClear();
    cancelGoogleSignIn.mockClear();
    await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
    await act(async () => renderer.root.findByProps({ testID: 'signin-header' }).props.onBack());
    expect(cancelGoogleSignIn).toHaveBeenCalledWith({ connectorId: 'connector-row-1', state: 'failed' });
    expect(WebBrowser.dismissAuthSession).toHaveBeenCalled();
    expect(router.back).toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('dismisses on expiry and on foreground with no pending attempt', async () => {
    searchParams.connectorId = 'google-account';
    searchParams.url = 'https://accounts.google.com/o/oauth2/v2/auth?state=expired';
    readInstallState.mockResolvedValue({ connected: false, signIn: undefined });
    vi.useFakeTimers();
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(readInstallState).toHaveBeenCalledWith({ workspaceId: 'workspace-1', connectorId: 'google-account' });
      expect(await readInstallState.mock.results[0]!.value).toEqual({ connected: false, signIn: undefined });
      await act(async () => { await Promise.resolve(); });
      expect(WebBrowser.dismissAuthSession).toHaveBeenCalled();
      expect(router.replace).toHaveBeenCalledWith('/beeline/settings/workbench');
      await act(async () => renderer.unmount());
      vi.mocked(router.replace).mockClear();
      vi.mocked(WebBrowser.dismissAuthSession).mockClear();
      await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
      await act(async () => {
        for (const listener of appStateListeners) listener('active');
        await Promise.resolve();
      });
      expect(WebBrowser.dismissAuthSession).toHaveBeenCalled();
      expect(router.replace).toHaveBeenCalledWith('/beeline/settings/workbench');
      await act(async () => renderer.unmount());
    } finally {
      vi.useRealTimers();
      searchParams.connectorId = 'connector-row-1';
    }
  });

  it('recovers a cold redirect to the original Room without reopening Google', async () => {
    searchParams.oauthReturn = 'returned';
    searchParams.url = '';
    storedReturn.set('beeline.google-auth-return.v1', JSON.stringify({ state: 'returned', roomId: 'room-2' }));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(ConnectorSignInScreen)); });
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'room-2' } });
    expect(storedReturn.size).toBe(0);
    await act(async () => renderer.unmount());
  });

  it('names the connector being authenticated', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(ConnectorSignInScreen));
      await Promise.resolve();
    });

    const header = renderer.root.findByProps({ testID: 'signin-header' });
    expect(header.props.eyebrow).toBe('Workbench');
    expect(header.props.title).toBe('Sign in to Tailscale');
    expect(header.props.meta).toBe('squire-box · login.tailscale.com');
    await act(async () => renderer.unmount());
  });
});
