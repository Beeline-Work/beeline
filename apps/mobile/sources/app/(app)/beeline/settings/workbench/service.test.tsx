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
      items: [{ id: 'builtin:wallet', title: 'Wallet', subtitle: 'built in', kind: 'connection', target: { kind: 'wallet' } }], alsoAvailable: [] }]);
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

it('Reproduction squire-spinner: an expired online computer offers Reconnect after failure', async () => {
  params.service = 'trusty-squire'; navigation.push.mockClear();
  const source = new MockWorkbenchSource(); const row = squireRow();
  source.readWorkbench = async () => companyWorkbench([{ ...row, machines: row.machines.map(m => ({
    ...m, reconnecting: false, error: 'Google reconnect failed', statusText: 'Google sign-in expired',
  })) }]);
  setWorkbenchSource(source);
  const renderer = await render();
  const computer = renderer.root.findByProps({ testID: 'squire-computer-machine-one' });
  expect(computer.props.action).toBe('Reconnect'); expect(computer.props.description).toBe('Google sign-in expired · Google reconnect failed');
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
    items: [{ id: 'notion-app', title: 'Notion', subtitle: 'via Trusty Squire', kind: 'connection' as const, target: { kind: 'app' as const, appId: 'notion' },
      status: status === 'error' ? 'Offline' : 'Connected', attention: status === 'error' }] });
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
    expect(appRow.props.chevron).toBeUndefined();
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
    expect(appRow.props.action).toBe('Reconnect');
    expect(appRow.props.description).toMatch(/^Laptop · /);
    await act(async () => { await appRow.props.onPress(); });
    expect(connect).toHaveBeenCalledWith({ workspaceId: 'ws', app: 'Notion', helperId: 'laptop', reconnect: true });
    expect(navigation.push).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
});
