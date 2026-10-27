import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
const opener = vi.hoisted(() => ({ openUrl: vi.fn(async (_url: string) => undefined) }));
const source = vi.hoisted(() => ({
  listHelpers: vi.fn(async () => [{ id: 'helper-1', online: true }]),
  connectApp: vi.fn(async (): Promise<{ appId: string; authorizationUrl?: string }> => ({ appId: 'github-app' })),
}));
const refresh = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('expo-router', () => ({ router: navigation, useLocalSearchParams: () => ({ workspaceId: 'ws-1', viewerId: 'viewer-1' }) }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', ScrollView: 'ScrollView', Pressable: 'Pressable', Linking: { openURL: vi.fn() } }));
vi.mock('@/components/buzz/HullDialog', () => ({ HullDialogInput: 'HullDialogInput' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => true }));
vi.mock('@/utils/isDesktopShell', () => ({ isDesktopShell: () => true }));
vi.mock('@tauri-apps/plugin-opener', () => opener);
vi.mock('@/buzz/use-active-community', () => ({ useActiveCommunityId: () => 'ws-1' }));
vi.mock('@/buzz/latency-route-hook', () => ({ useLatencyRouteFrame: vi.fn() }));
vi.mock('@/buzz/workbench-source', () => ({ getWorkbenchSource: () => source }));
vi.mock('@/buzz/wallet-source', () => ({ getWalletSource: vi.fn() }));
vi.mock('@/buzz/wallet-surface', () => ({ publishSharedWallet: vi.fn() }));
vi.mock('@/buzz/wallet-workspace', () => ({ resolveWalletWorkspaceId: vi.fn() }));
vi.mock('@/buzz/workbench-surface', () => ({
  readSharedWorkbench: refresh,
  useSharedWorkbench: () => ({ value: { companies: { hasConnections: false, suggestions: [{
    appKey: 'github', appName: 'GitHub', name: 'GitHub', providerId: 'github', providerName: 'GitHub',
    domain: 'github.com', purpose: 'Work with repositories and issues.', flow: 'app',
  }] } }, refresh }),
}));
vi.mock('@/components/buzz/Button', () => ({ Button: 'Button' }));
vi.mock('@/components/buzz/SettingsRow', () => ({ SettingsRow: 'SettingsRow' }));
vi.mock('@/components/buzz/PageHeader', () => ({ PageHeader: 'PageHeader' }));
vi.mock('@/components/buzz/ServiceMark', () => ({ ServiceMark: 'ServiceMark' }));
vi.mock('@/components/buzz/RoomListSectionHeader', () => ({ RoomListSectionHeader: 'RoomListSectionHeader' }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: 'SurfaceGlyphLoader' }));
vi.mock('@/components/buzz/NetworkUnavailableState', () => ({ NetworkUnavailableState: 'NetworkUnavailableState' }));
vi.mock('./workbench/connect-app', () => ({ ConnectorsSearchSheet: () => null }));

import WorkbenchScreen from './workbench';

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  source.connectApp.mockResolvedValue({ appId: 'github-app' });
  opener.openUrl.mockResolvedValue(undefined);
});

async function clickGitHub(check: (tree: any) => void) {
  let tree: any;
  try {
    await act(async () => { tree = create(<WorkbenchScreen />); });
    const row = tree.root.findByProps({ testID: 'connectors-suggest-github' });
    await act(async () => { row.props.onPress(); });
    expect(source.connectApp).toHaveBeenCalledWith(expect.objectContaining({ app: 'GitHub', helperId: 'helper-1', workspaceId: 'ws-1' }));
    await vi.waitFor(async () => {
      await act(async () => {});
      check(tree);
    });
  } finally { if (tree) await act(async () => tree.unmount()); }
}

it('R2594: clicking Suggested GitHub opens its connection page when setup has no authorization URL yet', async () => {
  await clickGitHub(() => {
    expect(navigation.push).toHaveBeenCalledWith({ pathname: '/beeline/settings/workbench/app', params: {
      workspaceId: 'ws-1', viewerId: 'viewer-1', appId: 'github-app',
    } });
    expect(opener.openUrl).not.toHaveBeenCalled();
  });
});

it('does not introduce management or delete controls for the Beeline GitHub App', async () => {
  await clickGitHub(tree => {
    const rendered = tree.root.findAll((node: any) => typeof node.type === 'string')
      .flatMap((node: any) => [node.props.label, node.props.accessibilityLabel,
        ...node.children.filter((child: unknown) => typeof child === 'string')]).join(' ');
    expect(rendered).not.toContain('Beeline GitHub App');
    expect(rendered).not.toMatch(/Delete GitHub|Disconnect GitHub|Remove GitHub/);
  });
});

it('opens a server-issued GitHub authorization link through the desktop system browser', async () => {
  source.connectApp.mockResolvedValue({ appId: 'github-app', authorizationUrl: 'https://github.com/login/oauth/authorize?state=fixture' });
  await clickGitHub(() => {
    expect(opener.openUrl).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?state=fixture');
    expect(navigation.push).not.toHaveBeenCalled();
  });
});

it('shows an actionable error if Windows cannot launch the authorization link', async () => {
  source.connectApp.mockResolvedValue({ appId: 'github-app', authorizationUrl: 'https://github.com/login/oauth/authorize?state=fixture' });
  opener.openUrl.mockRejectedValue(new Error('Could not open browser. Check your default browser and try again.'));
  await clickGitHub(tree => {
    const error = tree.root.findAllByType('SettingsRow').find((node: any) => node.props.title === 'Could not open browser. Check your default browser and try again.');
    expect(error.props.title).toBe('Could not open browser. Check your default browser and try again.');
  });
});
