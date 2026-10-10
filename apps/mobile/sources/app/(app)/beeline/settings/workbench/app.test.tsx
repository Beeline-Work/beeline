import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockWorkbenchSource } from '@/buzz/workbench-source.mock';
import { setWorkbenchSource } from '@/buzz/workbench-source';
import AppDetailScreen from './app';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
const signIn = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('expo-router', () => ({ router: navigation, useLocalSearchParams: () => ({ workspaceId: 'ws', viewerId: 'human-dani', appId: 'app-slack' }), useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect]) }));
vi.mock('@/buzz/app-sign-in', () => ({ openAppSignIn: signIn.open }));
const safeArea = vi.hoisted(() => ({ bottom: 0 }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: safeArea.bottom, left: 0, right: 0 }) }));
vi.mock('react-native', async () => {
  const R = await import('react');
  const host = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return { ScrollView: host('ScrollView'), Text: host('Text'), View: host('View'), Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default } };
});
vi.mock('@/components/buzz/AppMark', () => ({ AppMark: (props: any) => React.createElement('AppMark', props) }));
vi.mock('@/components/buzz/PageHeader', () => ({ PageHeader: (props: any) => React.createElement('PageHeader', props) }));
vi.mock('@/components/buzz/SettingsRow', () => ({ SettingsRow: (props: any) => React.createElement('SettingsRow', props) }));
vi.mock('@/components/buzz/HullActionSheet', () => ({
  HullActionSheetModal: (props: any) => React.createElement('HullActionSheetModal', props, props.children),
  HullActionSheetRow: (props: any) => React.createElement('HullActionSheetRow', props),
  HullActionSheetCancel: (props: any) => React.createElement('HullActionSheetCancel', props),
}));

let source: MockWorkbenchSource;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  source = new MockWorkbenchSource();
  source.setApps([{ id: 'app-slack', key: 'slack', name: 'Slack', domain: 'slack.com', transport: 'composio', status: 'connected', accountLabel: 'lunchbox', workspaceName: 'Tubing Crew', useCount: 1, lastUse: { agentId: 'monarch', agentName: 'Monarch', roomId: 'launch', roomName: 'launch', usedAt: 60 * 60 * 10 + 3 * 60 } }]);
  setWorkbenchSource(source);
  navigation.back.mockClear();
  navigation.push.mockClear();
  signIn.open.mockClear();
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(AppDetailScreen)); await Promise.resolve(); });
  return renderer;
}

function openStatus(renderer: ReactTestRenderer) {
  act(() => { renderer.root.findByType('SettingsRow' as never).props.trailingPress.onPress(); });
  return renderer.root.findAllByType('HullActionSheetRow' as never);
}

describe('App detail', () => {
  it('shows its status and agent use with controls in the status sheet', async () => {
    const renderer = await render();
    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain('Signed in');
    expect(tree).toContain('Monarch in #launch');
    expect(renderer.root.findByType('SettingsRow' as never).props.value).toBe('Connected');
    expect(openStatus(renderer).map((row: { props: { label: string } }) => row.props.label)).toEqual(['Disconnect']);
  });

  it('disconnects the exact app from the status sheet', async () => {
    const renderer = await render();
    const [disconnect] = openStatus(renderer);
    await act(async () => { disconnect.props.onPress(); await Promise.resolve(); });
    expect((await source.readWorkbench({ workspaceId: 'ws', viewerId: 'human-dani' })).apps).toHaveLength(0);
    expect(navigation.back).toHaveBeenCalledTimes(1);
  });

  it('retries a failed managed sign-in from the status sheet', async () => {
    source.setApps([{ id: 'app-slack', key: 'slack', name: 'Slack', transport: 'composio', status: 'error', useCount: 0 }]);
    source.beginAppSignIn = vi.fn().mockResolvedValue({ authorizationUrl: 'https://example.test/fresh' });
    const renderer = await render();
    const [reconnect] = openStatus(renderer);
    expect(reconnect.props.label).toBe('Reconnect');
    await act(async () => { reconnect.props.onPress(); await Promise.resolve(); });
    expect(signIn.open).toHaveBeenCalledWith('https://example.test/fresh', { workspaceId: 'ws', viewerId: 'human-dani', appId: 'app-slack' });
  });

  it('routes a missing Trusty Squire prerequisite to setup', async () => {
    source.setApps([{ id: 'app-slack', key: 'runway', name: 'Runway', transport: 'squire-api', status: 'error',
      errorMessage: 'Connect Trusty Squire in Connectors first', useCount: 0 }]);
    const renderer = await render();
    const [reconnect] = openStatus(renderer);
    expect(reconnect.props.label).toBe('Reconnect Trusty Squire');
    await act(async () => { reconnect.props.onPress(); });
    expect(navigation.push).toHaveBeenCalledWith({ pathname: '/beeline/settings/workbench/connect',
      params: { workspaceId: 'ws', viewerId: 'human-dani', connectorId: 'trusty-squire' } });
  });

  it('keeps the last row above the system navigation bar', async () => {
    safeArea.bottom = 48;
    try {
      const renderer = await render();
      const scroll = renderer.root.findByProps({ testID: 'app-detail-scroll' });
      const style = Object.assign({}, ...[scroll.props.contentContainerStyle].flat(Infinity as 1));
      expect(style.paddingBottom).toBe(72);
    } finally { safeArea.bottom = 0; }
  });
});
