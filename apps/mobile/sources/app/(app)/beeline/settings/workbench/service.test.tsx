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
  it('opens each credential through its existing authorized detail action', async () => {
    const renderer = await render(); const key = renderer.root.findByProps({ testID: 'company-item-vercel-key' });
    expect(key.props.title).toBe('Production API');
    await act(async () => key.props.onPress());
    expect(navigation.push).toHaveBeenCalledWith({ pathname: '/beeline/settings/workbench/connection', params: { workspaceId: 'ws', viewerId: 'human-dani', connectionId: 'vercel-key' } });
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
