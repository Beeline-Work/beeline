vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: async () => 'https://relay.test',
  loadBuzzIdentity: async () => ({ publicKey: 'human-dani' }),
}));
vi.mock('@/buzz/surface-storage', async () =>
  (await import('@/test/mock-surface-storage')).mockSurfaceStorage());
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({
  register: async () => () => undefined,
}) }));
import { mobileSurfaceCache } from '@/buzz/surface-storage';
import { MockWorkbenchSource } from '@/buzz/workbench-source.mock';
import { setWorkbenchSource } from '@/buzz/workbench-source';
import { companyWorkbench, companyRow, squireRow } from '@/test/company-workbench';
import ConnectorServiceScreen from './service';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
vi.mock('@/buzz/use-active-community', () => ({ useActiveCommunityId: () => 'ws' }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: () => null }));
const params = vi.hoisted(() => ({ service: 'vercel', helperId: '' }));
const browser = vi.hoisted(() => ({ open: vi.fn().mockResolvedValue({ type: 'dismiss' }) }));
vi.mock('expo-router', () => ({ router: navigation,
  useLocalSearchParams: () => ({ workspaceId: 'ws', viewerId: 'human-dani', service: params.service, helperId: params.helperId }),
  useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect]) }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: browser.open }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native', async () => { const R = await import('react');
  const host = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return { ScrollView: host('ScrollView'), Text: host('Text'), View: host('View') };
});
vi.mock('@/components/buzz/PageHeader', () => ({ PageHeader: (props: any) => React.createElement('PageHeader', props) }));
vi.mock('@/components/buzz/ServiceMark', () => ({ ServiceMark: (props: any) => React.createElement('ServiceMark', props) }));
vi.mock('@/components/buzz/SettingsRow', () => ({ SettingsRow: (props: any) => React.createElement('SettingsRow', props) }));
vi.mock('@/components/buzz/Button', () => ({ Button: (props: any) => React.createElement('Button', props) }));
vi.mock('@/components/buzz/HullActionSheet', () => ({
  HullActionSheetModal: (props: any) => React.createElement('HullActionSheetModal', props, props.children),
  HullActionSheetRow: (props: any) => React.createElement('HullActionSheetRow', props),
  HullActionSheetCancel: (props: any) => React.createElement('HullActionSheetCancel', props),
}));

beforeEach(() => {
  mobileSurfaceCache.clear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  params.service = 'vercel'; params.helperId = ''; browser.open.mockClear();
  const source = new MockWorkbenchSource(); source.readWorkbench = async () => companyWorkbench([companyRow('vercel', 'Vercel'), squireRow()]); setWorkbenchSource(source);
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(ConnectorServiceScreen)); await Promise.resolve(); });
  return renderer;
}

describe('company detail', () => {
  it('shows keys as plain rows and manages them only through the Trusty Squire vault', async () => {
    const renderer = await render(); const key = renderer.root.findByProps({ testID: 'company-item-vercel-key' });
    expect(key.props.title).toBe('Production API');
    expect(key.props.onPress).toBeUndefined(); expect(key.props.chevron).toBeUndefined();
    expect(renderer.root.findByProps({ testID: 'connector-info-status' }).props.value).toBe('Connected');
    expect(renderer.root.findByProps({ testID: 'connector-info-agents' }).props.children).toBe('Agents call Vercel with your keys, only on the hosts you allow.');
    expect([...renderer.root.findAllByType('SettingsRow'), ...renderer.root.findAllByType('Button')]
      .some((node: any) => /Disconnect/.test(`${node.props.title ?? ''} ${node.props.label ?? ''}`))).toBe(false);
    expect(renderer.root.findAllByType('HullActionSheetModal').every((sheet: any) => !sheet.props.visible)).toBe(true);
    await act(async () => renderer.root.findByProps({ testID: 'connector-squire-vault' }).props.onPress());
    expect(browser.open).toHaveBeenCalledWith('https://trustysquire.ai/vault');
    expect(navigation.push).not.toHaveBeenCalled();
  });
  it('lists only the also-available apps the server still offers', async () => {
    const source = new MockWorkbenchSource();
    source.readWorkbench = async () => companyWorkbench([{ ...companyRow('coinbase', 'Coinbase', 'apps'),
      items: [{ id: 'builtin:wallet', title: 'Coinbase wallet', subtitle: 'built in', kind: 'connection', target: { kind: 'wallet' } }], alsoAvailable: [] }]);
    setWorkbenchSource(source); params.service = 'coinbase';
    const renderer = await render();
    expect(renderer.root.findAll((node: any) => String(node.props?.testID ?? '').startsWith('company-available-'))).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'connector-squire-vault' })).toHaveLength(0);
  });
  it('shows only eligible computers in the sign-in service, with no key controls', async () => {
    params.service = 'trusty-squire'; const renderer = await render();
    expect(renderer.root.findAllByProps({ testID: 'company-item-vercel-key' })).toHaveLength(0);
    expect(renderer.root.findAllByType('SettingsRow').map((r: any) => r.props.title)).toEqual(['Trusty Squire', 'Laptop']);
  });
  it('disconnects the selected computer and refreshes the server answer', async () => {
    params.service = 'trusty-squire'; const source = new MockWorkbenchSource();
    const read = vi.spyOn(source, 'readWorkbench').mockResolvedValue(companyWorkbench([squireRow()]));
    const disconnect = vi.spyOn(source, 'disconnectConnector').mockResolvedValue(undefined); setWorkbenchSource(source);
    const renderer = await render(); await act(async () => renderer.root.findByProps({ testID: 'squire-computer-machine-one' }).props.onPress());
    await act(async () => renderer.root.findByType('HullActionSheetRow').props.onPress());
    expect(disconnect).toHaveBeenCalledWith({ workspaceId: 'ws', connectorId: 'squire:machine-one' }); expect(read.mock.calls.length).toBeGreaterThan(1);
  });
});

it('Reproduction squire-false-card: account replaces Ready and reconnect hides Disconnect', async () => {
  params.service = 'trusty-squire';
  const source = new MockWorkbenchSource();
  const row = squireRow();
  source.readWorkbench = async () => companyWorkbench([{ ...row, machines: row.machines.map(m => ({ ...m, signedInAs: 'owner@example.com', statusText: 'owner@example.com' })) }]);
  setWorkbenchSource(source);
  const renderer = await render();
  expect(renderer.root.findByProps({ testID: 'squire-computer-machine-one' }).props.value).toBe('owner@example.com');
  await act(async () => renderer.root.findByProps({ testID: 'squire-computer-machine-one' }).props.onPress());
  source.readWorkbench = async () => companyWorkbench([{ ...row, machines: row.machines.map(m => ({ ...m, reconnecting: true, statusText: 'Reconnecting…' })) }]);
  await act(async () => mobileSurfaceCache.clear());
  await act(async () => renderer.unmount());
  const reconnecting = await render();
  const computer = reconnecting.root.findByProps({ testID: 'squire-computer-machine-one' });
  expect(computer.props.value).toBe('Reconnecting…');
  expect(computer.props.disabled).toBe(true);
  await act(async () => computer.props.onPress());
  expect(reconnecting.root.findAllByType('HullActionSheetRow').filter((r: any) => r.props.label === 'Disconnect')).toHaveLength(0);
  await act(async () => reconnecting.unmount());
});

it('Reproduction squire-spinner: an expired online computer offers Connect after failure', async () => {
  params.service = 'trusty-squire'; navigation.push.mockClear();
  const source = new MockWorkbenchSource(); const row = squireRow();
  source.readWorkbench = async () => companyWorkbench([{ ...row, machines: row.machines.map(m => ({
    ...m, reconnecting: false, error: 'Google reconnect failed', statusText: 'Google sign-in expired',
  })) }]);
  setWorkbenchSource(source);
  const renderer = await render();
  const computer = renderer.root.findByProps({ testID: 'squire-computer-machine-one' });
  expect(computer.props.action).toBe('Connect'); expect(computer.props.description).toBe('Google sign-in expired · Google reconnect failed');
  await act(async () => computer.props.onPress());
  expect(navigation.push).toHaveBeenCalledWith({ pathname: '/beeline/settings/workbench/connect',
    params: { workspaceId: 'ws', viewerId: 'human-dani', connectorId: 'trusty-squire', helperId: 'machine-one' } });
  await act(async () => renderer.unmount());
});

it('shows the error, not a retry, when the computer that would retry is offline', async () => {
  params.service = 'trusty-squire'; navigation.push.mockClear();
  const source = new MockWorkbenchSource(); const row = squireRow();
  source.readWorkbench = async () => companyWorkbench([{ ...row, machines: row.machines.map(m => ({ ...m, online: false, status: 'error' as const, statusText: 'Computer offline' })) }]);
  setWorkbenchSource(source);
  const renderer = await render();
  const computer = renderer.root.findByProps({ testID: 'squire-computer-machine-one' });
  expect(computer.props.action).toBeUndefined(); expect(computer.props.value).toBe('Computer offline');
  await act(async () => computer.props.onPress());
  expect(renderer.root.findByProps({ testID: 'squire-computer-offline' }).props.children).toBe('Turn on Laptop to reconnect it.');
  expect(renderer.root.findAllByType('HullActionSheetRow')).toHaveLength(0);
  expect(navigation.push).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

describe('app connections on the info page', () => {
  const notionRow = (status: 'connected' | 'error') => ({ ...companyRow('notion', 'Notion', status === 'error' ? 'attention' : 'apps'), subtitle: '1 app',
    state: status === 'error' ? 'connect' as const : 'connected' as const,
    items: [{ id: 'notion-app', title: 'Notion', subtitle: 'via Trusty Squire', kind: 'connection' as const, target: { kind: 'app' as const, appId: 'notion' },
      state: status === 'error' ? 'connect' as const : 'connected' as const, attention: status === 'error' }] });
  const notionApp = (status: 'connected' | 'error') => ({ id: 'notion', key: 'notion', name: 'Notion', transport: 'squire-browser', status, useCount: 0,
    helperId: 'laptop', helperName: 'Laptop', ...(status === 'error' ? { errorMessage: 'Notion sign-in expired' } : {}) }) as any;
  function serveNotion(status: 'connected' | 'error') {
    const source = new MockWorkbenchSource();
    source.readWorkbench = async () => ({ ...companyWorkbench([notionRow(status)]), apps: [notionApp(status)] });
    setWorkbenchSource(source); params.service = 'notion';
    return source;
  }
  it('connected: disconnects from the info page itself, with no app page pushed', async () => {
    navigation.push.mockClear();
    const source = serveNotion('connected');
    const disconnect = vi.spyOn(source, 'disconnectApp').mockResolvedValue(undefined as any);
    const renderer = await render();
    const appRow = renderer.root.findByProps({ testID: 'company-item-notion-app' });
    expect(appRow.props.chevron).toBe('right');
    expect(appRow.props.value).toBeUndefined();
    expect(appRow.props.action).toBeUndefined();
    await act(async () => appRow.props.onPress());
    expect(navigation.push).not.toHaveBeenCalled();
    const sheet = renderer.root.findAllByType('HullActionSheetModal').find((node: any) => node.props.title === 'Notion');
    expect(sheet.props.visible).toBe(true);
    await act(async () => { sheet.findByType('HullActionSheetRow').props.onPress(); await Promise.resolve(); });
    expect(disconnect).toHaveBeenCalledWith({ workspaceId: 'ws', appId: 'notion' });
    expect(navigation.push).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
  it('errored: shows the computer and retries on it in one tap, with no app page pushed', async () => {
    navigation.push.mockClear();
    const source = serveNotion('error');
    vi.spyOn(source, 'listHelpers').mockResolvedValue([{ id: 'laptop', name: 'Laptop', online: true }] as any);
    const connect = vi.spyOn(source, 'connectApp').mockResolvedValue({ appId: 'notion' } as any);
    const renderer = await render();
    const appRow = renderer.root.findByProps({ testID: 'company-item-notion-app' });
    expect(appRow.props.action).toBe('Connect');
    expect(appRow.props.description).toMatch(/^Laptop · /);
    await act(async () => { await appRow.props.onPress(); });
    expect(connect).toHaveBeenCalledWith({ workspaceId: 'ws', app: 'Notion', helperId: 'laptop', reconnect: true });
    expect(navigation.push).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
  it('top-row Connect retries the app that needs it through the same path', async () => {
    navigation.push.mockClear();
    const source = serveNotion('error');
    vi.spyOn(source, 'listHelpers').mockResolvedValue([{ id: 'laptop', name: 'Laptop', online: true }] as any);
    const connect = vi.spyOn(source, 'connectApp').mockResolvedValue({ appId: 'notion' } as any);
    const renderer = await render();
    const top = renderer.root.findByProps({ testID: 'connector-info-status' });
    expect(top.props.action).toBe('Connect');
    await act(async () => { await top.props.onPress(); });
    expect(connect).toHaveBeenCalledWith({ workspaceId: 'ws', app: 'Notion', helperId: 'laptop', reconnect: true });
    expect(navigation.push).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
});

describe('built-in connections that need sign-in', () => {
  function serveBuiltin(providerId: string, name: string, item: { id: string; title: string; target: any }) {
    const source = new MockWorkbenchSource();
    source.readWorkbench = async () => companyWorkbench([{ ...companyRow(providerId, name, 'attention'), state: 'connect' as const, attention: '1 connection needs attention',
      items: [{ ...item, subtitle: 'built in', kind: 'connection' as const, state: 'connect' as const, attention: true }], alsoAvailable: [] }]);
    setWorkbenchSource(source); params.service = providerId;
  }
  const cases = [
    { providerId: 'google', name: 'Google', item: { id: 'builtin:google', title: 'Google sign-in', target: { kind: 'connector', connectorId: 'google' } },
      route: { pathname: '/beeline/settings/workbench/connect', params: { workspaceId: 'ws', viewerId: 'human-dani', connectorId: 'google' } } },
    { providerId: 'tailscale', name: 'Tailscale', item: { id: 'builtin:tailscale', title: 'Tailscale', target: { kind: 'connector', connectorId: 'tailscale' } },
      route: { pathname: '/beeline/settings/workbench/connect', params: { workspaceId: 'ws', viewerId: 'human-dani', connectorId: 'tailscale' } } },
    { providerId: 'coinbase', name: 'Coinbase', item: { id: 'builtin:wallet', title: 'Coinbase wallet', target: { kind: 'wallet' } },
      route: { pathname: '/beeline/settings/workbench/wallet', params: { workspaceId: 'ws', viewerId: 'human-dani' } } },
  ];
  for (const { providerId, name, item, route } of cases) {
    it(`${item.title}: row and top-row Connect both open its existing connection page`, async () => {
      navigation.push.mockClear(); serveBuiltin(providerId, name, item);
      const renderer = await render();
      const row = renderer.root.findByProps({ testID: `company-item-${item.id}` });
      expect(row.props.action).toBe('Connect');
      expect(row.props.value).toBeUndefined();
      await act(async () => row.props.onPress());
      expect(navigation.push).toHaveBeenLastCalledWith(route);
      const top = renderer.root.findByProps({ testID: 'connector-info-status' });
      expect(top.props.action).toBe('Connect');
      await act(async () => top.props.onPress());
      expect(navigation.push).toHaveBeenCalledTimes(2);
      expect(navigation.push).toHaveBeenLastCalledWith(route);
      await act(async () => renderer.unmount());
    });
  }
});

describe('three-state connection status', () => {
  const googleApp = (id: string, name: string, status: 'connected' | 'error', extra: Record<string, unknown> = {}) => ({
    id, key: id, name, transport: 'composio', status, useCount: 0, ...extra,
  }) as any;
  it('shows Connected once on a healthy company and omits it from app rows', async () => {
    const source = new MockWorkbenchSource();
    source.readWorkbench = async () => ({ ...companyWorkbench([{
      ...companyRow('google', 'Google', 'apps'), subtitle: '4 apps', state: 'connected' as const,
      items: [
        { id: 'gmail', title: 'Gmail', subtitle: 'via Composio', kind: 'connection' as const, target: { kind: 'app' as const, appId: 'gmail' }, state: 'connected' as const },
        { id: 'cal', title: 'Google Calendar', subtitle: 'via Composio', kind: 'connection' as const, target: { kind: 'app' as const, appId: 'cal' }, state: 'connected' as const },
        { id: 'drive', title: 'Google Drive', subtitle: 'via Composio', kind: 'connection' as const, target: { kind: 'app' as const, appId: 'drive' }, state: 'connected' as const },
        { id: 'builtin:google', title: 'Google sign-in', subtitle: 'built in', kind: 'connection' as const, target: { kind: 'connector' as const, connectorId: 'google' }, state: 'connected' as const },
      ],
    }]), apps: [googleApp('gmail', 'Gmail', 'connected'), googleApp('cal', 'Google Calendar', 'connected'), googleApp('drive', 'Google Drive', 'connected')] });
    setWorkbenchSource(source); params.service = 'google';
    const renderer = await render();
    const connected = renderer.root.findAllByType('SettingsRow').filter((row: any) => row.props.value === 'Connected');
    expect(connected).toHaveLength(1);
    expect(connected[0].props.testID).toBe('connector-info-status');
    for (const id of ['gmail', 'cal', 'drive', 'builtin:google']) {
      const row = renderer.root.findByProps({ testID: `company-item-${id}` });
      expect(row.props.value).toBeUndefined();
      expect(row.props.action).toBeUndefined();
      expect(row.props.statusGlyph).toBeUndefined();
    }
    await act(async () => renderer.unmount());
  });
  it('shows Connect and Error on the rows that need them, never Reconnect or Offline', async () => {
    const source = new MockWorkbenchSource();
    source.readWorkbench = async () => ({ ...companyWorkbench([{
      ...companyRow('google', 'Google', 'attention'), subtitle: '4 apps', state: 'error' as const,
      status: 'App provider request failed (403)', attention: '1 connection needs attention',
      items: [
        { id: 'gmail', title: 'Gmail', subtitle: 'via Composio', kind: 'connection' as const, target: { kind: 'app' as const, appId: 'gmail' }, state: 'connected' as const },
        { id: 'cal', title: 'Google Calendar', subtitle: 'via Composio', kind: 'connection' as const, target: { kind: 'app' as const, appId: 'cal' }, state: 'connect' as const, attention: true },
        { id: 'drive', title: 'Google Drive', subtitle: 'via Composio', kind: 'connection' as const, target: { kind: 'app' as const, appId: 'drive' },
          state: 'error' as const, status: 'App provider request failed (403)', attention: true },
        { id: 'sheets', title: 'Google Sheets', subtitle: 'via Composio', kind: 'connection' as const, target: { kind: 'app' as const, appId: 'sheets' }, state: 'connected' as const },
      ],
    }]), apps: [
      googleApp('gmail', 'Gmail', 'connected'),
      googleApp('cal', 'Google Calendar', 'error', { errorMessage: 'Sign-in expired' }),
      googleApp('drive', 'Google Drive', 'error', { errorMessage: 'App provider request failed (403)' }),
      googleApp('sheets', 'Google Sheets', 'connected'),
    ] });
    setWorkbenchSource(source); params.service = 'google';
    const renderer = await render();
    const connect = renderer.root.findByProps({ testID: 'company-item-cal' });
    const error = renderer.root.findByProps({ testID: 'company-item-drive' });
    const healthy = renderer.root.findByProps({ testID: 'company-item-gmail' });
    expect(connect.props.action).toBe('Connect');
    expect(error.props.value).toBe('App provider request failed (403)');
    expect(error.props.valueTone).toBe('danger');
    expect(error.props.action).toBeUndefined();
    expect(healthy.props.value).toBeUndefined();
    expect(healthy.props.action).toBeUndefined();
    const copy = renderer.root.findAllByType('SettingsRow').flatMap((row: any) =>
      [row.props.value, row.props.action, row.props.title, row.props.description]).join(' ');
    expect(copy).not.toMatch(/Reconnect/);
    expect(copy).not.toMatch(/Offline/);
    await act(async () => renderer.unmount());
  });
});

it('Reproduction MCP-DISCOVERY-1: the service-page MCP row starts the existing ceremony while keys remain plain rows', async () => {
  const source = new MockWorkbenchSource();
  const option = { appKey: 'fly', appName: 'Fly.io', name: 'Fly.io', purpose: 'Fly MCP',
    providerId: 'fly', providerName: 'Fly.io', domain: 'fly.io', logo: { kind: 'monogram' as const },
    flow: 'app' as const, registryServerName: 'io.fly/company-mcp', registryVersion: 'verified-version' };
  source.readWorkbench = async () => companyWorkbench([{ ...companyRow('fly', 'Fly.io'), domain: 'fly.io', mcp: option }]);
  source.listHelpers = async () => [{ id: 'squire', name: 'Squire', online: true, platform: 'linux', agentCount: 1 }];
  const connect = vi.spyOn(source, 'connectApp').mockResolvedValue({ appId: 'fly-mcp' });
  setWorkbenchSource(source); params.service = 'fly';
  const renderer = await render();
  const entry = renderer.root.findByProps({ testID: 'company-mcp-connect' });
  expect(entry.props.title).toBe('Fly.io'); expect(entry.props.description).toBe('Sign in with Fly MCP');
  expect(renderer.root.findByProps({ testID: 'company-item-fly-key' }).props.onPress).toBeUndefined();
  await act(async () => entry.props.onPress());
  await vi.waitFor(() => expect(connect).toHaveBeenCalledWith(expect.objectContaining({
    app: 'Fly.io', registryServerName: 'io.fly/company-mcp', registryVersion: 'verified-version',
  })));
});
