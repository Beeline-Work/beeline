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
  setWorkbenchSource(new MockWorkbenchSource());
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

describe('Connectors settings screen', () => {
  it('shows the shared Connectors header and search entry', async () => {
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'workbench-header' }).props).toMatchObject({
      title: 'Connectors', eyebrow: 'Settings',
    });
    act(() => renderer.root.findByProps({ testID: 'connectors-search' }).props.onPress());
    expect(navigation.push.mock.calls.at(-1)?.[0]).toMatchObject({
      pathname: '/beeline/settings/workbench/connect-app',
      params: { workspaceId: 'workspace-1', viewerId: 'human-dani' },
    });
  });

  it('groups one key service row per vault reference and opens its read-only page', async () => {
    const source = new MockWorkbenchSource();
    const read = source.readWorkbench.bind(source);
    source.readWorkbench = async input => {
      const view = await read(input);
      return { ...view, connections: [...view.connections, view.connections[0]!] };
    };
    setWorkbenchSource(source);
    const renderer = await render();
    const rows = renderer.root.findAllByType('SettingsRow');
    const vercel = rows.filter((row: any) => row.props.title === 'Vercel');
    expect(vercel).toHaveLength(1);
    expect(vercel[0]?.props.description).toBe('Key · Trusty Squire');
    act(() => vercel[0]?.props.onPress());
    expect(navigation.push.mock.calls.at(-1)?.[0]).toMatchObject({
      pathname: '/beeline/settings/workbench/service',
      params: { service: 'vercel' },
    });
  });

  it('keeps a Squire-held app key in Keys while real sign-ins appear as connections', async () => {
    const source = new MockWorkbenchSource();
    source.setApps([
      { id: 'app-rakuten', key: 'rakuten', name: 'Rakuten Ichiba', transport: 'squire-api', status: 'connected', connectionReference: 'cred_rakuten', useCount: 0 },
      { id: 'app-slack', key: 'slack', name: 'Slack', transport: 'composio', status: 'connected', useCount: 0 },
    ]);
    const read = source.readWorkbench.bind(source);
    source.readWorkbench = async input => {
      const view = await read(input);
      return { ...view, apps: view.apps.filter(app => app.transport !== 'squire-api'), connections: [...view.connections,
        { connectionId: 'cred_rakuten', ref: 'cred_rakuten', name: 'Rakuten key', service: 'rakuten', hosts: [], state: 'active' as const, ownerId: 'human-dani' }] };
    };
    setWorkbenchSource(source);
    const renderer = await render();
    const titles = renderer.root.findAllByType('SettingsRow').map((row: any) => row.props.title);
    expect(titles).toContain('Rakuten Ichiba');
    expect(titles).toContain('Slack');
    expect(titles).not.toContain('Rakuten key');
  });

  it('offers Trusty Squire in recommendations when it has never connected', async () => {
    searchParams.params = { workspaceId: 'workspace-1', viewerId: 'human-terra' };
    const renderer = await render();
    const hero = renderer.root.findByProps({ testID: 'connectors-squire-hero' });
    act(() => hero.props.onAction());
    expect(navigation.push.mock.calls.at(-1)?.[0]).toMatchObject({
      pathname: '/beeline/settings/workbench/connect',
      params: { connectorId: 'trusty-squire' },
    });
  });

  it('uses the held view on focus and re-reads after a live workbench change', async () => {
    const source = new MockWorkbenchSource();
    const read = vi.spyOn(source, 'readWorkbench');
    setWorkbenchSource(source);
    await render();
    expect(read).toHaveBeenCalledWith({ workspaceId: 'workspace-1', viewerId: 'human-dani' });
    const firstReads = read.mock.calls.length;
    await act(async () => { focus.effect?.(); await Promise.resolve(); });
    expect(read).toHaveBeenCalledTimes(firstReads);
    await act(async () => {
      for (const listener of liveListeners) listener({ monolithLive: {
        type: 'resource-change', roomId: '', resource: 'workbench',
      } });
      await Promise.resolve();
    });
    expect(read).toHaveBeenLastCalledWith({ workspaceId: 'workspace-1', viewerId: 'human-dani' });
  });

  it('Reproduction connectors-squire-not-added: re-reads a stored view once so a connected machine is not "Not added"', async () => {
    const source = new MockWorkbenchSource();
    const read = source.readWorkbench.bind(source);
    const machine = { id: 'machine-squire', name: 'squire', online: true };
    source.readWorkbench = async input => ({ ...await read(input),
      helpers: [{ ...machine, squire: { status: 'connected' as const, reportedAt: 2 } }] });
    setWorkbenchSource(source);
    // The view this device stored before the machine's broker report reached it.
    const stored = { ...await read({ workspaceId: 'workspace-1', viewerId: 'human-dani' }), helpers: [machine] };
    await mobileSurfaceCache.write({ relayOrigin: 'https://relay.test', viewerPubkey: 'human-dani',
      endpoint: '/workspace/:id/workbench', params: { workspaceId: 'workspace-1', viewerId: 'human-dani' } },
    stored, (value): value is typeof stored => Boolean(value));
    const renderer = await render();
    const squire = () => renderer.root.findAllByType('SettingsRow')
      .find((row: any) => row.props.title === 'Trusty Squire · squire');
    await vi.waitFor(() => expect(squire()?.props.value).toBe('Connected'));
    expect(squire()?.props.statusGlyph).toBe('live');
  });

  it('states the Settings total as exactly the rows under Your connections', async () => {
    const key = (ref: string, service: string) => ({ connectionId: ref, ref, name: 'default', service,
      hosts: [], state: 'active' as const, ownerId: 'human-dani' });
    const tool = (id: string, name: string) => ({ id, name, description: '', available: true,
      status: 'connected' as const });
    const view: WorkbenchView = {
      helpers: [
        { id: 'machine-squire', name: 'squire', online: true, squire: { status: 'connected', reportedAt: 1 } },
        { id: 'machine-other', name: 'other', online: false },
      ],
      // Tiktok-app and Cal.com hold two keys each and draw one row each.
      connections: [key('k1', 'tiktok-app'), key('k2', 'tiktok-app'), key('k3', 'kaggle'),
        key('k4', 'cal.com'), key('k5', 'cal.com'), key('k6', 'craigslist')],
      apps: [
        { id: 'app-linear', key: 'linear', name: 'Linear', transport: 'registry-mcp', status: 'connected', useCount: 0 },
        { id: 'app-slack', key: 'slack', name: 'Slack', transport: 'composio', status: 'connecting', useCount: 0 },
      ],
      connectors: [tool('trusty-squire', 'Trusty Squire'), tool('google-gmail', 'Gmail'),
        tool('google-calendar', 'Google Calendar'), tool('google-drive', 'Google Drive'),
        tool('google-youtube', 'YouTube'), tool('tailscale', 'Tailscale'), tool('wallet', 'Wallet')],
      linkAccount: { connected: true, pending: false, ineligible: false },
    };
    const source = new MockWorkbenchSource();
    source.readWorkbench = async () => view;
    setWorkbenchSource(source);
    const renderer = await render();
    const rows = renderer.root.findByProps({ testID: 'connectors-your-connections' })
      .findAllByType('SettingsRow');
    // 2 machines + 4 key services + 2 apps + Google Workspace + Tailscale + wallet + Link.
    expect(rows).toHaveLength(12);
    expect(workbenchSummary(view, 'human-dani').value).toBe(`${rows.length} connected`);
  });

  it('connects the recommended wallet by creating it and granting delegation', async () => {
    const wallet = new MockWalletSource();
    const create = vi.spyOn(wallet, 'createWallet');
    const grant = vi.spyOn(wallet, 'grantDelegation');
    setWalletSource(wallet);
    const renderer = await render();
    await act(async () => {
      renderer.root.findByProps({ testID: 'connectors-recommended-wallet' }).props.onPress();
      await Promise.resolve();
    });
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });
    expect(grant).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });
    expect(navigation.push.mock.calls.at(-1)?.[0]).toMatchObject({
      pathname: '/beeline/settings/workbench/wallet', params: { workspaceId: 'workspace-1' },
    });
  });

  it('uses the active Workspace for wallet connect from personal Settings', async () => {
    searchParams.params = { viewerId: 'human-dani' };
    const wallet = new MockWalletSource();
    const create = vi.spyOn(wallet, 'createWallet');
    setWalletSource(wallet);
    const renderer = await render();
    await act(async () => {
      renderer.root.findByProps({ testID: 'connectors-recommended-wallet' }).props.onPress();
      await Promise.resolve();
    });
    expect(workspace.resolve).toHaveBeenCalledWith('', 'workspace-active');
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-active' });
  });

  it('returns from Link sign-in to a connected row', async () => {
    const source = new MockWorkbenchSource();
    const originalRead = source.readWorkbench.bind(source);
    let connected = false;
    source.beginLinkSignIn = vi.fn(async () => ({ authorizationUrl: 'https://login.link.com/auth?state=link-test-state' }));
    source.readWorkbench = async input => ({ ...await originalRead(input),
      linkAccount: { connected, pending: false, ineligible: false } });
    vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async () => {
      connected = true;
      return { type: 'success', url: 'beeline://beeline/settings/workbench' };
    });
    setWorkbenchSource(source);
    const renderer = await render();
    await act(async () => {
      renderer.root.findByProps({ testID: 'connectors-recommended-link' }).props.onPress();
      await Promise.resolve();
    });
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
      'https://login.link.com/auth?state=link-test-state',
      'beeline://beeline/settings/workbench', expect.anything());
    expect(renderer.root.findAllByType('SettingsRow').some((row: any) =>
      row.props.title === 'Link' && row.props.value === 'Connected')).toBe(true);
  });

  it('keeps the last loaded view when a later vault read fails', async () => {
    const source = new MockWorkbenchSource();
    const read = source.readWorkbench.bind(source);
    let fail = false;
    source.readWorkbench = async input => {
      if (fail) throw new Error('offline');
      return read(input);
    };
    setWorkbenchSource(source);
    const renderer = await render();
    expect(renderer.root.findAllByType('SettingsRow').some((row: any) => row.props.title === 'Vercel')).toBe(true);
    fail = true;
    await act(async () => {
      for (const listener of liveListeners) listener({ monolithLive: {
        type: 'resource-change', roomId: '', resource: 'workbench',
      } });
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({ testID: 'workbench-network-unavailable' })).toBeDefined();
  });
});
