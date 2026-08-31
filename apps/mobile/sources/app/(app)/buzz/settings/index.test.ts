import { readFileSync } from 'node:fs';

import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const identityStorage = vi.hoisted(() => ({
  clearBuzzIdentity: vi.fn(async () => undefined),
  loadBuzzIdentity: vi.fn(async () => null),
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.example'),
}));
const surfaceStorage = vi.hoisted(() => ({ clearMobileSurfaceStorage: vi.fn() }));
const authSession = vi.hoisted(() => ({
  clearPendingGitHubSignInState: vi.fn(async () => undefined),
}));
const updates = vi.hoisted(() => ({
  isEnabled: true,
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));
const appConfig = vi.hoisted(() => ({
  releaseVersion: 'v0.0.1',
  releaseSha: '1234567890abcdef1234567890abcdef12345678',
}));

vi.mock('expo-router', () => ({ router: navigation }));
vi.mock('expo-updates', () => ({
  updateId: 'ota-running-123',
  channel: 'preview',
  get isEnabled() {
    return updates.isEnabled;
  },
  checkForUpdateAsync: updates.checkForUpdateAsync,
  fetchUpdateAsync: updates.fetchUpdateAsync,
  reloadAsync: updates.reloadAsync,
}));
vi.mock('@/auth/buzz-identity-storage', () => identityStorage);
vi.mock('@/auth/github-auth-session', () => authSession);
vi.mock('@/buzz/surface-storage', () => surfaceStorage);
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    async workspaceGitHubAccess() {
      return { installed: false, installations: [], candidates: [] };
    }
  },
}));
vi.mock('@/sync/appConfig', () => ({ loadAppConfig: () => appConfig }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    ActivityIndicator: host('ActivityIndicator'),
    Linking: { openURL: vi.fn(async () => undefined) },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    hairlineDivider: { borderBottomWidth: 1, borderBottomColor: '#4e4e4e' },
    HullSurface: host('HullSurface'),
    PixelGateReveal: host('PixelGateReveal'),
  };
});

import BuzzSettings from './index';

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
beforeEach(() => {
  vi.clearAllMocks();
  updates.isEnabled = true;
  updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false });
  updates.fetchUpdateAsync.mockResolvedValue({
    isNew: true,
    isRollBackToEmbedded: false,
    manifest: { id: 'ota-next' },
  });
  updates.reloadAsync.mockResolvedValue(undefined);
});

function render(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(BuzzSettings));
  });
  return renderer;
}

describe('Buzz global Settings', () => {
  it('names the GitHub installation section precisely', () => {
    const renderer = render();
    const text = renderer.root
      .findAllByType('Text' as any)
      .flatMap((node) => node.props.children)
      .join(' ');

    expect(text).toContain('CONNECTED GITHUB ACCOUNTS');
    expect(text).not.toContain('CONNECTED ACCOUNTS');
  });

  it('shows the running OTA id and channel on the device settings surface', () => {
    const renderer = render();

    expect(renderer.root.findByProps({ testID: 'ota-update-running-id' }).props.children).toEqual([
      'Running update: ',
      'ota-running-123',
    ]);
    expect(renderer.root.findByProps({ testID: 'ota-update-channel' }).props.children).toEqual([
      'Channel: ',
      'preview',
    ]);
    expect(renderer.root.findByProps({ testID: 'ota-release-version' }).props.children).toEqual([
      'Release: ',
      'v0.0.1',
      ' · 1234567890ab',
    ]);
  });

  it('checks on demand and reports when the running build is latest', async () => {
    const renderer = render();

    await act(async () => {
      await renderer.root.findByProps({ testID: 'ota-update-check' }).props.onPress();
    });

    expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ testID: 'ota-update-status' }).props.children).toBe(
      "You're on the latest version.",
    );
    expect(renderer.root.findByProps({ testID: 'ota-update-check' }).props.disabled).toBe(false);
  });

  it('downloads an available update with progress before reloading', async () => {
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true });
    let finishDownload!: (value: {
      isNew: true;
      isRollBackToEmbedded: false;
      manifest: { id: string };
    }) => void;
    updates.fetchUpdateAsync.mockReturnValue(
      new Promise((resolve) => {
        finishDownload = resolve;
      }),
    );
    const renderer = render();

    let updateRun!: Promise<void>;
    await act(async () => {
      updateRun = renderer.root.findByProps({ testID: 'ota-update-check' }).props.onPress();
      await Promise.resolve();
    });

    expect(updates.fetchUpdateAsync).toHaveBeenCalledOnce();
    expect(renderer.root.findByProps({ testID: 'ota-update-progress' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'ota-update-check' }).props.accessibilityLabel).toBe(
      'Downloading…',
    );

    await act(async () => {
      finishDownload({
        isNew: true,
        isRollBackToEmbedded: false,
        manifest: { id: 'ota-next' },
      });
      await updateRun;
    });

    expect(updates.reloadAsync).toHaveBeenCalledOnce();
    expect(renderer.root.findByProps({ testID: 'ota-update-check' }).props.accessibilityLabel).toBe(
      'Reloading…',
    );
  });

  it('returns to an actionable error state when the check fails', async () => {
    updates.checkForUpdateAsync.mockRejectedValue(new Error('offline'));
    const renderer = render();

    await act(async () => {
      await renderer.root.findByProps({ testID: 'ota-update-check' }).props.onPress();
    });

    expect(renderer.root.findByProps({ testID: 'ota-update-status' }).props.children).toContain(
      'try again',
    );
    expect(renderer.root.findByProps({ testID: 'ota-update-check' }).props.disabled).toBe(false);
    expect(renderer.root.findAllByProps({ testID: 'ota-update-progress' })).toHaveLength(0);
  });

  it('disables the control with a clear note when expo-updates is unavailable', () => {
    updates.isEnabled = false;
    const renderer = render();

    expect(renderer.root.findByProps({ testID: 'ota-update-check' }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ testID: 'ota-update-status' }).props.children).toBe(
      'Updates are unavailable in this build.',
    );
  });

  it('is the one coherent account surface, reachable and not a dead end', () => {
    // The Workspace rail's YOU command opens this hub; every screen that
    // mounts the rail must route there rather than jumping past it into
    // `settings/identity`, which is what stranded this screen — and the only
    // sign-out in the product with it.
    const railScreens = [
      '../../../../app/(app)/buzz/channels.tsx',
      '../../../../app/(app)/buzz/community.tsx',
      '../../../../app/(app)/buzz/corners/[roomId].tsx',
      '../../../../app/(app)/buzz/MembersScreen.tsx',
      '../../../../app/(app)/buzz/chat/[channelId].tsx',
      '../../../../app/(app)/join/[token].tsx',
    ];
    for (const relativePath of railScreens) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source, `${relativePath} mounts the rail`).toContain('onSettings=');
      expect(source, `${relativePath} skips the settings hub`).not.toContain(
        "onSettings={() => router.push('/buzz/settings/identity'",
      );
      expect(source, `${relativePath} should open the hub`).toContain(
        "onSettings={() => router.push('/buzz/settings' as Href)}",
      );
    }
    // ...and the hub itself is the only thing that opens the identity screen.
    const renderer = render();
    expect(renderer.root.findByProps({ testID: 'backup-key-setting' })).toBeDefined();
  });

  it('renders as an index, not a stack of cards', () => {
    // DESIGN.md: a box never wraps a repeating content unit. The one box left
    // on this screen is the destructive confirmation, a non-repeating notice.
    const source = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');
    const rowStyle = source.slice(source.indexOf('  settingsRow: {'));
    const rowBlock = rowStyle.slice(0, rowStyle.indexOf('},') + 2);
    expect(rowBlock).not.toMatch(/borderWidth|borderRadius|backgroundColor/);
    expect(rowBlock).toMatch(/borderBottomWidth:\s*1/);
    expect(rowBlock).toMatch(/borderBottomColor:\s*groknight\.border/);
    // Persistent chrome carries no lifted surface of its own.
    expect(source).not.toContain('<HullSurface');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('contains key backup and sign-out actions without relay switching', async () => {
    const renderer = render();
    const text = renderer.root
      .findAllByType('Text' as any)
      .flatMap((node) => node.props.children)
      .join(' ');

    expect(text).toContain('My Settings');
    expect(text).toContain('Sign out');
    expect(text).not.toContain('Forget key');
    expect(text).not.toContain('Relay URL');

    act(() => renderer.root.findByProps({ testID: 'backup-key-setting' }).props.onPress());
    expect(navigation.push).toHaveBeenCalledWith('/buzz/settings/identity');

    await act(async () => {
      await renderer.root.findByProps({ testID: 'sign-out-setting' }).props.onPress();
    });
    expect(identityStorage.clearBuzzIdentity).not.toHaveBeenCalled();
    const warning = renderer.root
      .findAllByType('Text' as any)
      .flatMap((node) => node.props.children)
      .join(' ');
    expect(warning).toContain('permanently erases');
    expect(warning).toContain('cannot restore');
    act(() => renderer.root.findByProps({ testID: 'backup-before-sign-out' }).props.onPress());
    expect(navigation.push).toHaveBeenCalledWith('/buzz/settings/identity');
    await act(async () => {
      await renderer.root.findByProps({ testID: 'sign-out-setting' }).props.onPress();
    });
    expect(identityStorage.clearBuzzIdentity).toHaveBeenCalledOnce();
    expect(authSession.clearPendingGitHubSignInState).toHaveBeenCalledOnce();
    expect(surfaceStorage.clearMobileSurfaceStorage).toHaveBeenCalledOnce();
    expect(navigation.replace).toHaveBeenCalledWith('/buzz/onboarding');
  });
});
