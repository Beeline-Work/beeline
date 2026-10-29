vi.mock('@expo/vector-icons', async () => { const R = await import('react'); return { Ionicons: (props: any) => R.createElement('Ionicons', props) }; });
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'Light' }, impactAsync: async () => undefined }));
vi.mock('react-native-keyboard-controller', async () => { const R = await import('react'); return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) }; });
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const searchParams = vi.hoisted(() => ({
  params: {
    workspaceId: 'workspace-1',
    viewerId: 'human-dani',
  } as Record<string, string>,
}));

vi.mock('expo-router', () => ({
  router: navigation,
  useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  useLocalSearchParams: () => searchParams.params,
}));

vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: async () => 'https://relay.test',
  loadBuzzIdentity: async () => ({ publicKey: 'human-dani' }),
}));
vi.mock('@/buzz/surface-storage', async () =>
  (await import('@/test/mock-surface-storage')).mockSurfaceStorage());

vi.mock('@/components/buzz/Button', async () => {
  const R = await import('react');
  // The one Button, as a host press target carrying its label.
  return {
    Button: ({ label, ...props }: any) =>
      R.createElement('TouchableOpacity', { ...props, label }, R.createElement('Text', null, label)),
  };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    ScrollView: host('ScrollView'),
    StyleSheet: { flatten: (style: any): any => Array.isArray(style) ? Object.assign({}, ...style) : style,  create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    Image: host('Image'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
    ActivityIndicator: host('ActivityIndicator'),
    Animated: {
      View: host('Animated.View'),
      Text: host('Animated.Text'),
      Value: class {
        value = 1;
        setValue(v: number) {
          this.value = v;
        }
        interpolate() {
          return {};
        }
      },
      loop: () => ({ start: () => {}, stop: () => {} }),
      sequence: (...args: unknown[]) => args,
      timing: () => ({ start: () => {}, stop: () => {} }),
    },
  };
});

vi.mock('@/components/buzz/SettingsRow', async () => {
  const ReactModule = await import('react');
  return {
    SettingsRow: (props: any) => ReactModule.createElement('SettingsRow', props),
  };
});

vi.mock('@/components/buzz/PageHeader', async () => {
  const ReactModule = await import('react');
  return {
    PageHeader: (props: any) => ReactModule.createElement('PageHeader', props),
  };
});
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});

const signIn = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/buzz/app-sign-in', () => ({ openAppSignIn: signIn.open }));

const safeArea = vi.hoisted(() => ({ bottom: 0 }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: safeArea.bottom, left: 0 }),
}));

import { companyWorkbench, companyOption, companyRow } from '@/test/company-workbench';
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('@/buzz/use-active-community', () => ({ useActiveCommunityId: () => 'workspace-1' }));
const discoveryLive = vi.hoisted(() => ({ listener: undefined as undefined | ((event: any) => void) }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: async (_filter: unknown, listener: (event: any) => void) => { discoveryLive.listener = listener; return () => {}; } }) }));
import ConnectAppScreen from './connect-app';
import { setWorkbenchSource } from '@/buzz/workbench-source';
import { MockWorkbenchSource } from '@/buzz/workbench-source.mock';
import { mobileSurfaceCache } from '@/buzz/surface-storage';

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
afterEach(() => vi.clearAllMocks());

let source: MockWorkbenchSource;
beforeEach(() => {
  mobileSurfaceCache.clear();
  source = new MockWorkbenchSource();
  source.readWorkbench = async () => companyWorkbench([], [companyOption('resend', 'Resend')]);
  source.searchApps = async ({ query }) => query === 'vercel' ? [{ appKey: 'vercel', name: 'Vercel', companyId: 'vercel' }] : query === 'resend' ? [{ appKey: 'resend', name: 'Resend', company: { ...companyOption('resend', 'Resend'), registryServerName: 'com.resend/mcp', registryVersion: '1.2' } }] : [];
  setWorkbenchSource(source);
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(ConnectAppScreen));
    await Promise.resolve();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  return renderer;
}

async function search(renderer: ReactTestRenderer, query: string): Promise<void> {
  await act(async () => renderer.root.findByProps({ testID: 'connect-app-input' }).props.onChangeText(query));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 230)); });
}

describe('server-owned connector search', () => {
  it('uses the server suggestions only while the query is empty', async () => {
    const renderer = await render(); expect(renderer.root.findByType('SettingsRow').props.title).toBe('Resend');
    await search(renderer, 'unknown'); expect(renderer.root.findAllByType('SettingsRow')).toHaveLength(0); expect(JSON.stringify(renderer.toJSON())).toContain('No connections found');
  });
  it('navigates an existing company instead of offering a second install', async () => {
    const renderer = await render(); await search(renderer, 'vercel');
    await act(async () => renderer.root.findByType('SettingsRow').props.onPress());
    expect(navigation.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ service: 'vercel' }) })); expect(source.appRequests).toHaveLength(0);
  });
  it('opens an existing company by the same one-tap rule as its Connectors row', async () => {
    source.readWorkbench = async () => companyWorkbench([{ ...companyRow('coinbase', 'Coinbase', 'apps'),
      items: [{ id: 'builtin:wallet', title: 'Coinbase wallet', subtitle: 'built in', kind: 'connection', target: { kind: 'wallet' } }] }]);
    source.searchApps = async () => [{ appKey: 'coinbase', name: 'Coinbase', companyId: 'coinbase' }];
    const renderer = await render(); await search(renderer, 'coin');
    await act(async () => renderer.root.findByType('SettingsRow').props.onPress());
    expect(navigation.push).toHaveBeenCalledWith({ pathname: '/beeline/settings/workbench/wallet', params: { workspaceId: 'workspace-1', viewerId: 'human-dani' } });
  });
  it('preserves selected registry coordinates and the existing sign-in ceremony', async () => {
    const connect = vi.spyOn(source, 'connectApp').mockResolvedValue({ appId: 'new-app', authorizationUrl: 'https://signin.example/auth' });
    const renderer = await render(); await search(renderer, 'resend');
    await act(async () => { await renderer.root.findByType('SettingsRow').props.onPress(); });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledWith(expect.objectContaining({ app: 'Resend', helperId: 'helper-squire-box', registryServerName: 'com.resend/mcp', registryVersion: '1.2' })));
    expect(signIn.open).toHaveBeenCalledWith('https://signin.example/auth', { workspaceId: 'workspace-1', viewerId: 'human-dani', appId: 'new-app' });
  });
  it('keeps the bottom safe area on the scroll content', async () => {
    safeArea.bottom = 48; const renderer = await render(); expect(renderer.root.findByProps({ testID: 'connect-app-scroll' }).props.contentContainerStyle.paddingBottom).toBe(48);
  });
});


it('MCP-DISCOVERY-1: a committed discovery refreshes the current query without clearing existing rows or polling', async () => {
  let discovered = false;
  source.readWorkbench = async () => companyWorkbench([], [companyOption('resend', 'Resend')]);
  const existing = { appKey: 'vercel', name: 'Vercel', companyId: 'vercel' };
  const added = { appKey: 'fly', name: 'Fly.io', company: { ...companyOption('fly', 'Fly.io'), registryServerName: 'io.fly/company-mcp', registryVersion: '1' } };
  const calls = vi.fn(async () => discovered ? [existing, added] : [existing]);
  source.searchApps = calls;
  const renderer = await render();
  await search(renderer, 'fly');
  expect(renderer.root.findAllByType('SettingsRow').map((row: any) => row.props.title)).toEqual(['Vercel']);
  discovered = true;
  await act(async () => { discoveryLive.listener?.({ monolithLive: { type: 'resource-change', roomId: '', resource: 'workbench' } }); await Promise.resolve(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(renderer.root.findAllByType('SettingsRow').map((row: any) => row.props.title)).toEqual(['Vercel', 'Fly.io']);
  const count = calls.mock.calls.length;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  expect(calls).toHaveBeenCalledTimes(count);
});
