import * as React from 'react';
import * as WebBrowser from 'expo-web-browser';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const layout = vi.hoisted(() => ({ desktop: false }));
const searchParams = vi.hoisted(() => ({
  params: { workspaceId: 'workspace-1', viewerId: 'human-dani' } as Record<string, string>,
}));
const workspace = vi.hoisted(() => ({
  resolve: vi.fn(async (id?: string, activeId?: string): Promise<string | null> => id || activeId || null),
}));
vi.mock('@/buzz/wallet-workspace', () => ({ resolveWalletWorkspaceId: workspace.resolve }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: async () => 'https://relay.test',
  loadBuzzIdentity: async () => ({ publicKey: 'human-dani' }),
}));
vi.mock('@/buzz/surface-storage', async () =>
  (await import('@/test/mock-surface-storage')).mockSurfaceStorage());
vi.mock('@/buzz/use-active-community', () => ({ useActiveCommunityId: () => 'workspace-active' }));
const focus = vi.hoisted(() => ({
  effect: undefined as undefined | (() => void | (() => void)),
}));
const appState = vi.hoisted(() => ({
  listener: undefined as undefined | ((state: string) => void),
}));
const liveListeners = vi.hoisted(() => new Set<(event: any) => void>());
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({
  register: async (_filters: unknown, listener: (event: any) => void) => {
    liveListeners.add(listener);
    return () => liveListeners.delete(listener);
  },
}) }));

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => searchParams.params,
  useFocusEffect: (effect: () => void | (() => void)) => {
    focus.effect = effect;
    React.useEffect(effect, [effect]);
  },
}));
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(async () => ({ type: 'success' })),
}));

const safeArea = vi.hoisted(() => ({ bottom: 0 }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: safeArea.bottom, left: 0 }),
}));

vi.mock('@/utils/responsive', () => ({
  useIsDesktop: () => layout.desktop,
}));

vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example.test' }),
}));

vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: {
      addEventListener: (_event: string, listener: (state: string) => void) => {
        appState.listener = listener;
        return { remove: () => undefined };
      },
    },
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    Image: host('Image'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
    Animated: {
      Value: (v: number) => ({
        _value: v,
        add: () => ({ _value: v }),
        interpolate: () => ({ _value: v }),
      }),
      timing: () => ({ start: () => undefined }),
      sequence: () => ({ start: () => undefined }),
      loop: () => ({ start: () => undefined, stop: () => undefined }),
      View: host('Animated.View'),
    },
  };
});

vi.mock('@/components/buzz/SettingsRow', async () => {
  const ReactModule = await import('react');
  return {
    SettingsRow: (props: any) => ReactModule.createElement('SettingsRow', props),
  };
});
vi.mock('@/components/buzz/HullActionSheet', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return {
    HullActionSheetModal: host('HullActionSheetModal'),
    HullActionSheetRow: host('HullActionSheetRow'),
    HullActionSheetCancel: host('HullActionSheetCancel'),
  };
});

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(async () => undefined),
}));
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});

import { companyWorkbench, companyRow, companyOption, squireRow } from '@/test/company-workbench';
import WorkbenchScreen from './workbench';
import { WALLET_GRANT_ENDED_MESSAGE, type WorkbenchView } from '@/buzz/workbench';
import { workbenchSummary } from '@/buzz/connectors-model';
import { setWorkbenchSource } from '@/buzz/workbench-source';
import { MockWorkbenchSource } from '@/buzz/workbench-source.mock';
import { setWalletSource } from '@/buzz/wallet-source';
import { MockWalletSource } from '@/buzz/wallet-source.mock';
import { mobileSurfaceCache } from '@/buzz/surface-storage';
import { resetClientState } from '@/sync/client-reset';

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
afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.clearAllMocks();
  resetClientState();
  mobileSurfaceCache.clear();
  liveListeners.clear();
  focus.effect = undefined;
  appState.listener = undefined;
  layout.desktop = false;
  safeArea.bottom = 0;
  const source = new MockWorkbenchSource();
  source.readWorkbench = async () => companyWorkbench([squireRow(), companyRow('vercel', 'Vercel')]);
  setWorkbenchSource(source);
  setWalletSource(new MockWalletSource());
  searchParams.params = { workspaceId: 'workspace-1', viewerId: 'human-dani' };
  workspace.resolve.mockImplementation(async (id?: string, activeId?: string) => id || activeId || null);
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(WorkbenchScreen));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('Connectors server-owned settings screen', () => {
  it('renders the server companies once with authoritative marks and company detail targets', async () => {
    const renderer = await render();
    const rows = renderer.root.findAllByType('SettingsRow');
    expect(rows.map((r: any) => r.props.title)).toEqual(['Trusty Squire', 'Vercel']);
    expect(rows[1].props.leading.props.mark.uri).toContain('/v1/company-logos/vercel');
    await act(async () => rows[1].props.onPress());
    expect(navigation.push).toHaveBeenCalledWith({ pathname: '/beeline/settings/workbench/service', params: { workspaceId: 'workspace-1', viewerId: 'human-dani', service: 'vercel' } });
    expect(renderer.root.findByProps({ testID: 'connectors-search' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ testID: 'connectors-suggest-squire' })).toHaveLength(0);
  });
  it('only shows suggestions in the body for an empty account', async () => {
    const source = new MockWorkbenchSource();
    source.readWorkbench = async () => companyWorkbench([], [companyOption('trusty-squire', 'Trusty Squire', 'squire')]);
    setWorkbenchSource(source);
    const renderer = await render();
    const suggestion = renderer.root.findByType('SettingsRow');
    expect(suggestion.props.title).toBe('Trusty Squire');
    await act(async () => suggestion.props.onPress());
    expect(navigation.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ connectorId: 'trusty-squire' }) }));
  });
  it('re-reads after a committed live change without client regrouping', async () => {
    const source = new MockWorkbenchSource();
    let value = companyWorkbench([companyRow('vercel', 'Vercel')]);
    const read = vi.spyOn(source, 'readWorkbench').mockImplementation(async () => value);
    setWorkbenchSource(source);
    const renderer = await render();
    value = companyWorkbench([companyRow('sentry', 'Sentry', 'attention')]);
    await act(async () => { for (const listener of liveListeners) listener({ monolithLive: { type: 'resource-change', roomId: '', resource: 'workbench' } }); await Promise.resolve(); });
    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(renderer.root.findByType('SettingsRow').props.title).toBe('Sentry');
  });
  it('refreshes a stale stored server answer once per session', async () => {
    const source = new MockWorkbenchSource();
    source.readWorkbench = async () => companyWorkbench([squireRow()]);
    setWorkbenchSource(source);
    await mobileSurfaceCache.write({ relayOrigin: 'https://relay.test', viewerPubkey: 'human-dani', endpoint: '/workspace/:id/workbench',
      params: { workspaceId: 'workspace-1', viewerId: 'human-dani' } }, companyWorkbench([squireRow('not-added')]), (v): v is WorkbenchView => Boolean(v));
    const renderer = await render();
    await vi.waitFor(() => expect(renderer.root.findByType('SettingsRow').props.value).toBe('Ready'));
  });
  it('creates and delegates the suggested wallet with the active workspace fallback', async () => {
    searchParams.params.workspaceId = '';
    const source = new MockWorkbenchSource(); source.readWorkbench = async () => companyWorkbench([], [companyOption('wallet', 'Wallet', 'wallet')]);
    setWorkbenchSource(source);
    const wallet = new MockWalletSource(); const create = vi.spyOn(wallet, 'createWallet'); const grant = vi.spyOn(wallet, 'grantDelegation'); setWalletSource(wallet);
    const renderer = await render();
    await act(async () => { await renderer.root.findByType('SettingsRow').props.onPress(); });
    await vi.waitFor(() => expect(grant).toHaveBeenCalledWith({ workspaceId: 'workspace-active' }));
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-active' });
  });
  it('cancels a dismissed Link sign-in rather than granting anything', async () => {
    const source = new MockWorkbenchSource(); source.readWorkbench = async () => companyWorkbench([], [companyOption('link', 'Link', 'link')]);
    vi.spyOn(source, 'beginLinkSignIn').mockResolvedValue({ authorizationUrl: 'https://link.example/auth?state=pending' });
    const cancel = vi.spyOn(source, 'cancelLinkSignIn').mockResolvedValue(undefined);
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({ type: 'dismiss' as WebBrowser.WebBrowserResultType.DISMISS });
    setWorkbenchSource(source); const renderer = await render();
    await act(async () => { await renderer.root.findByType('SettingsRow').props.onPress(); });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('pending'));
  });
});
