import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockWorkbenchSource } from '@/buzz/workbench-source.mock';
import { setWorkbenchSource } from '@/buzz/workbench-source';
import ConnectorServiceScreen from './service';

const params = vi.hoisted(() => ({ service: 'vercel' }));
const browser = vi.hoisted(() => ({ open: vi.fn().mockResolvedValue({ type: 'dismiss' }) }));
vi.mock('expo-router', () => ({ router: { back: vi.fn(), push: vi.fn() },
  useLocalSearchParams: () => ({ workspaceId: 'ws', viewerId: 'human-dani', service: params.service }),
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
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  params.service = 'vercel'; browser.open.mockClear();
  setWorkbenchSource(new MockWorkbenchSource());
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(ConnectorServiceScreen)); await Promise.resolve(); });
  return renderer;
}

describe('key service', () => {
  it('lists key metadata without controls or values and opens the Squire vault from one Manage row', async () => {
    const renderer = await render();
    const rows = renderer.root.findAllByType('SettingsRow' as never);
    const key = rows.find((row: { props: { title: string } }) => row.props.title === 'Vercel');
    expect(key).toBeTruthy();
    expect(key.props.onPress).toBeUndefined();
    expect(key.props.chevron).toBeUndefined();
    const manage = rows.find((row: { props: { title: string } }) => row.props.title === 'Manage in Trusty Squire');
    expect(manage).toBeTruthy();
    expect(rows.filter((row: { props: { onPress?: () => void } }) => row.props.onPress)).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).not.toMatch(/Add key|Edit|Delete|secret value/);
    await act(async () => { manage.props.onPress(); await Promise.resolve(); });
    expect(browser.open).toHaveBeenCalledWith('https://trustysquire.ai/vault');
  });

  it('shows only Squire purpose and status on the Squire page', async () => {
    params.service = 'trusty-squire';
    const renderer = await render();
    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain('Trusty Squire signs up and signs in');
    expect(renderer.root.findAllByType('SettingsRow' as never).map((row: { props: { title: string } }) => row.props.title))
      .toEqual(['Status']);
    expect(tree).not.toContain('KEYS IT HOLDS');
    expect(tree).not.toContain('Open vault');
  });
});
