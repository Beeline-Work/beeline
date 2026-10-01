import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockWorkbenchSource } from '@/buzz/workbench-source.mock';
import { setWorkbenchSource } from '@/buzz/workbench-source';
import AppDetailScreen from './app';

const navigation = vi.hoisted(() => ({ back: vi.fn() }));
const signIn = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('expo-router', () => ({ router: navigation, useLocalSearchParams: () => ({ workspaceId: 'ws', viewerId: 'human-dani', appId: 'app-slack' }), useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect]) }));
vi.mock('@/buzz/app-sign-in', () => ({ openAppSignIn: signIn.open }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native', async () => {
  const R = await import('react');
  const host = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return { ScrollView: host('ScrollView'), Text: host('Text'), TouchableOpacity: host('TouchableOpacity'), View: host('View'), Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default } };
});
vi.mock('@/components/buzz/AppMark', () => ({ AppMark: (props: any) => React.createElement('AppMark', props) }));
vi.mock('@/components/buzz/AppPageHeader', () => ({ AppPageHeader: (props: any) => React.createElement('AppPageHeader', props) }));

let source: MockWorkbenchSource;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  source = new MockWorkbenchSource();
  source.setApps([{ id: 'app-slack', key: 'slack', name: 'Slack', domain: 'slack.com', transport: 'composio', status: 'connected', accountLabel: 'lunchbox', workspaceName: 'Tubing Crew', useCount: 1, lastUse: { agentId: 'monarch', agentName: 'Monarch', roomId: 'launch', roomName: 'launch', usedAt: 60 * 60 * 10 + 3 * 60 } }]);
  setWorkbenchSource(source);
  navigation.back.mockClear();
  signIn.open.mockClear();
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(AppDetailScreen)); await Promise.resolve(); });
  return renderer;
}

describe('App detail', () => {
  it('shows the owner account, permission boundary, last use, and outlined Disconnect', async () => {
    const renderer = await render();
    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain('lunchbox');
    expect(tree).toContain(' · Tubing Crew workspace');
    expect(tree).toContain('Other people’s agents ask you first.');
    expect(tree).toContain('Monarch in #launch');
    expect(renderer.root.findByProps({ testID: 'app-detail-disconnect' })).toBeTruthy();
  });

  it('shows provider description and logo on detail', async () => {
    source.setApps([{ id: 'app-slack', key: 'slack', name: 'Slack',
      description: 'Send messages to your team.', logo: 'https://cdn.composio.dev/slack.png',
      transport: 'composio', status: 'connecting', useCount: 0 }]);
    const renderer = await render();
    expect(JSON.stringify(renderer.toJSON())).toContain('Send messages to your team.');
    expect(renderer.root.findByType('AppMark' as never).props.logo).toBe('https://cdn.composio.dev/slack.png');
    expect(renderer.root.findByProps({ testID: 'app-detail-disconnect' })).toBeTruthy();
    await act(async () => { renderer.root.findByProps({ testID: 'app-detail-disconnect' }).props.onPress(); await Promise.resolve(); });
    expect((await source.readWorkbench({ workspaceId: 'ws', viewerId: 'human-dani' })).apps).toHaveLength(0);
  });

  it('shows a product description on Neon detail when provider copy is missing or filler', async () => {
    source.setApps([{ id: 'app-slack', key: 'neon', name: 'Neon',
      description: 'Use neon tools.', transport: 'squire-api', status: 'connected', useCount: 0 }]);
    const renderer = await render();
    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain('Neon provides serverless Postgres databases for applications.');
    expect(tree).not.toContain('Use neon tools.');
    expect(renderer.root.findByType('AppMark' as never).props.name).toBe('Neon');
  });

  it('shows a truthful never-used state', async () => {
    source.setApps([{ id: 'app-slack', key: 'slack', name: 'Slack', transport: 'composio', status: 'connected', accountLabel: 'lunchbox', workspaceName: 'Tubing Crew', useCount: 0 }]);
    const renderer = await render();
    expect(JSON.stringify(renderer.toJSON())).toContain('Not used yet.');
  });

  it.each(['Slack', 'Example App'])('shows a failed %s retry as an error with another retry action', async (name) => {
    source.setApps([{ id: 'app-slack', key: name.toLowerCase().replace(/\s/g, ''), name, transport: 'composio',
      status: 'connecting', accountLabel: 'lunchbox', workspaceName: 'Tubing Crew', useCount: 0 }]);
    source.beginAppSignIn = vi.fn().mockRejectedValue(new Error('App provider request failed (403)'));
    const renderer = await render();
    await act(async () => {
      renderer.root.findByProps({ testID: 'app-detail-connect' }).props.onPress();
      await Promise.resolve();
    });
    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain('Connection failed');
    expect(tree).toContain(`Retry ${name}`);
    expect(tree).toContain('The app provider refused this connection (403).');
    expect(tree).not.toContain('Monolith');
    expect(renderer.root.findByProps({ testID: 'app-detail-disconnect' })).toBeTruthy();
  });

  it('disconnects the exact app through the server source', async () => {
    const renderer = await render();
    await act(async () => { renderer.root.findByProps({ testID: 'app-detail-disconnect' }).props.onPress(); await Promise.resolve(); });
    expect((await source.readWorkbench({ workspaceId: 'ws', viewerId: 'human-dani' })).apps).toHaveLength(0);
    expect(navigation.back).toHaveBeenCalledTimes(1);
  });
});
