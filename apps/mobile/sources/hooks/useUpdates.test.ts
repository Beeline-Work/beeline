import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ pathname: '/beeline/onboarding' }));
const desktopShell = vi.hoisted(() => ({ enabled: false }));
const appState = vi.hoisted(() => ({
  listeners: new Set<(state: string) => void>(),
}));
const updates = vi.hoisted(() => ({
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));
const tracking = vi.hoisted(() => ({
  available: vi.fn(),
  applied: vi.fn(),
}));
const desktopUpdater = vi.hoisted(() => ({ check: vi.fn() }));
const desktopProcess = vi.hoisted(() => ({ relaunch: vi.fn() }));

vi.mock('expo-router', () => ({ usePathname: () => route.pathname }));
vi.mock('expo-updates', () => ({
  checkForUpdateAsync: updates.checkForUpdateAsync,
  fetchUpdateAsync: updates.fetchUpdateAsync,
  reloadAsync: updates.reloadAsync,
}));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => desktopShell.enabled }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: desktopUpdater.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: desktopProcess.relaunch }));
vi.mock('@/track', () => ({
  trackOtaUpdateAvailable: tracking.available,
  trackOtaUpdateApplied: tracking.applied,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@expo/vector-icons', async () => {
  const ReactModule = await import('react');
  return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});
vi.mock('@/components/StyledText', async () => {
  const ReactModule = await import('react');
  return { Text: (props: any) => ReactModule.createElement('Text', props, props.children) };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) =>
      factory({
        colors: {
          surface: '#111',
          text: '#fff',
          textLink: '#fc0',
          textSecondary: '#aaa',
        },
      }),
  },
  useUnistyles: () => ({
    theme: { colors: { textLink: '#fc0', textSecondary: '#aaa' } },
  }),
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: {
      addEventListener: (_event: string, listener: (state: string) => void) => {
        appState.listeners.add(listener);
        return { remove: () => appState.listeners.delete(listener) };
      },
    },
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    View: host('View'),
  };
});

import { UpdateProvider } from './useUpdates';
import { UpdateReadyPrompt } from '@/components/UpdateReadyPrompt';

const originalConsoleError = console.error;

beforeAll(() => {
  vi.stubGlobal('__DEV__', false);
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  appState.listeners.clear();
  route.pathname = '/beeline/onboarding';
  desktopShell.enabled = false;
  updates.checkForUpdateAsync.mockResolvedValue({
    isAvailable: false,
    reason: 'noUpdateAvailableOnServer',
  });
  updates.fetchUpdateAsync.mockResolvedValue({ isNew: false });
  updates.reloadAsync.mockResolvedValue(undefined);
  desktopUpdater.check.mockResolvedValue(null);
  desktopProcess.relaunch.mockResolvedValue(undefined);
  delete process.env.EXPO_PUBLIC_BEELINE_DESKTOP_UPDATES;
});

async function renderUpdateRoot(child?: React.ReactNode): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      React.createElement(
        UpdateProvider,
        null,
        child ?? React.createElement('UnauthenticatedOnboarding'),
      ),
    );
  });
  return renderer;
}

async function unmount(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => renderer.unmount());
}

async function flushDynamicImports(): Promise<void> {
  await act(async () => {
    // Updater and process are separate lazy imports with installation between
    // them. Drain both module turns before asserting the restart boundary.
    for (let turn = 0; turn < 3; turn += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

function availableUpdate() {
  updates.checkForUpdateAsync.mockResolvedValue({
    isAvailable: true,
    manifest: { id: 'ota-next', runtimeVersion: '55' },
  });
  updates.fetchUpdateAsync.mockResolvedValue({
    isNew: true,
    manifest: { id: 'ota-next', runtimeVersion: '55' },
  });
}

describe('root OTA update coordinator', () => {
  it('checks for updates while the unauthenticated onboarding tree is mounted', async () => {
    const renderer = await renderUpdateRoot();

    expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByType('UnauthenticatedOnboarding' as any)).toHaveLength(1);
    await unmount(renderer);
  });

  it('reloads a fetched update immediately on a cold onboarding surface', async () => {
    availableUpdate();

    const renderer = await renderUpdateRoot();

    expect(updates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(updates.reloadAsync).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('surfaces a restart prompt instead of reloading during an active session', async () => {
    route.pathname = '/session/session-1';
    availableUpdate();

    const renderer = await renderUpdateRoot(React.createElement(UpdateReadyPrompt));

    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'ota-update-ready-prompt' })).not.toHaveLength(0);

    const restart = renderer.root.find(
      (node: any) => node.type === 'Pressable' && node.props.testID === 'ota-update-restart',
    );
    await act(async () => restart.props.onPress());
    expect(updates.reloadAsync).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('lets the user dismiss the active-session restart prompt', async () => {
    route.pathname = '/beeline/chat/room-1';
    availableUpdate();
    const renderer = await renderUpdateRoot(React.createElement(UpdateReadyPrompt));
    const dismiss = renderer.root.find(
      (node: any) => node.type === 'Pressable' && node.props.testID === 'ota-update-dismiss',
    );

    await act(async () => dismiss.props.onPress({ stopPropagation: vi.fn() }));

    expect(renderer.root.findAllByProps({ testID: 'ota-update-ready-prompt' })).toHaveLength(0);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    await unmount(renderer);
  });

  it('does not reload when the update download did not complete', async () => {
    route.pathname = '/beeline/onboarding';
    updates.checkForUpdateAsync.mockResolvedValue({
      isAvailable: true,
      manifest: { id: 'ota-next', runtimeVersion: '55' },
    });
    updates.fetchUpdateAsync.mockResolvedValue({
      isNew: false,
      manifest: undefined,
      isRollBackToEmbedded: false,
    });

    const renderer = await renderUpdateRoot(React.createElement(UpdateReadyPrompt));

    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'ota-update-ready-prompt' })).toHaveLength(0);
    await unmount(renderer);
  });

  it('checks again whenever the app becomes active', async () => {
    const renderer = await renderUpdateRoot();
    expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of appState.listeners) listener('active');
    });

    expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(2);
    await unmount(renderer);
  });

  it('downloads a signed desktop update and relaunches immediately on an idle route', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    desktopShell.enabled = true;
    process.env.EXPO_PUBLIC_BEELINE_DESKTOP_UPDATES = '1';
    desktopUpdater.check.mockResolvedValue({ version: '0.2.21', downloadAndInstall });

    const renderer = await renderUpdateRoot();
    await flushDynamicImports();
    await vi.waitFor(() => expect(desktopProcess.relaunch).toHaveBeenCalledTimes(1));

    expect(desktopUpdater.check).toHaveBeenCalledTimes(1);
    expect(updates.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('waits through active desktop work and restarts when navigation becomes idle', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    desktopShell.enabled = true;
    process.env.EXPO_PUBLIC_BEELINE_DESKTOP_UPDATES = '1';
    route.pathname = '/beeline/chat/room-1';
    desktopUpdater.check.mockResolvedValue({ version: '0.2.21', downloadAndInstall });
    const child = React.createElement(UpdateReadyPrompt);
    const renderer = await renderUpdateRoot(child);
    await flushDynamicImports();
    expect(downloadAndInstall).not.toHaveBeenCalled();

    route.pathname = '/beeline/channels';
    await act(async () => renderer.update(React.createElement(UpdateProvider, null, child)));
    await flushDynamicImports();
    await vi.waitFor(() => expect(desktopProcess.relaunch).toHaveBeenCalledTimes(1));

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('restores the prompt after an automatic desktop install fails and retries only on demand', async () => {
    const downloadAndInstall = vi.fn()
      .mockRejectedValueOnce(new Error('install failed'))
      .mockResolvedValueOnce(undefined);
    desktopShell.enabled = true;
    process.env.EXPO_PUBLIC_BEELINE_DESKTOP_UPDATES = '1';
    desktopUpdater.check.mockResolvedValue({ version: '0.2.21', downloadAndInstall });
    const child = React.createElement(UpdateReadyPrompt);
    const renderer = await renderUpdateRoot(child);

    await act(async () => {
      await vi.waitFor(() => expect(downloadAndInstall).toHaveBeenCalledTimes(1));
    });
    expect(renderer.root.findAllByProps({ testID: 'ota-update-ready-prompt' })).not.toHaveLength(0);

    route.pathname = '/beeline/channels/settings';
    await act(async () => renderer.update(React.createElement(UpdateProvider, null, child)));
    await flushDynamicImports();
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.root.findByProps({ testID: 'ota-update-restart' }).props.onPress();
    });
    await act(async () => {
      await vi.waitFor(() => expect(desktopProcess.relaunch).toHaveBeenCalledTimes(1));
    });
    expect(downloadAndInstall).toHaveBeenCalledTimes(2);
    await unmount(renderer);
  });
});
