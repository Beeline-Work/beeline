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
const transport = vi.hoisted(() => ({ deleteCalls: 0, failDelete: false }));
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
  updateId: '01a06fba-cbb7-7f45-b86b-1e49b043f56a',
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
    async deleteAccount() {
      if (transport.failDelete) throw new Error('offline');
      transport.deleteCalls += 1;
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
    PixelLoader: host('PixelLoader'),
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
  transport.deleteCalls = 0;
  transport.failDelete = false;
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

    // The section head is written in sentence case and set in the one tracked
    // -capitals role (`type.sectionHead`), exactly as the Members page writes
    // `People 3` — the uppercase is presentation, not copy.
    expect(text).toContain('Connected GitHub accounts');
    expect(text).not.toContain('Connected accounts');
  });

  it('puts the release on the trailing axis and the machine ids on one quiet line', () => {
    // The row used to spill the running update UUID down three lines. The
    // release is the value a person wants, so it hangs in the trailing column
    // where every other row's value hangs; the channel and the update id are
    // machine detail on the row's one quiet line.
    const renderer = render();
    const row = renderer.root.findByProps({ testID: 'ota-update-info' }).props;

    expect(row.value).toBe('v0.0.1 · 1234567890ab');
    // The channel and a readable prefix of the running update id, not the
    // whole UUID down three lines.
    expect(row.description).toBe('preview · 01a06fba');
    expect(row.action).toBeUndefined();
  });

  it('checks on demand and reports when the running build is latest', async () => {
    const renderer = render();

    await act(async () => {
      await renderer.root.findByProps({ testID: 'ota-update-check' }).props.onPress();
    });

    expect(updates.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ testID: 'ota-update-check' }).props.description).toBe(
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

    expect(renderer.root.findByProps({ testID: 'ota-update-check' }).props.description).toContain(
      'try again',
    );
    expect(renderer.root.findByProps({ testID: 'ota-update-check' }).props.disabled).toBe(false);
    expect(renderer.root.findAllByProps({ testID: 'ota-update-progress' })).toHaveLength(0);
  });

  it('disables the control with a clear note when expo-updates is unavailable', () => {
    updates.isEnabled = false;
    const renderer = render();

    expect(renderer.root.findByProps({ testID: 'ota-update-check' }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ testID: 'ota-update-check' }).props.description).toBe(
      'Updates are unavailable in this build.',
    );
  });

  it('is the one coherent account surface, reachable and not a dead end', () => {
    // The Workspace rail's YOU command opens this hub; every screen that
    // mounts the rail must route there rather than jumping past it into
    // `settings/identity`, which is what stranded this screen — and the only
    // sign-out in the product with it.
    const railScreens = [
      '../../../../app/(app)/beeline/channels.tsx',
      '../../../../app/(app)/beeline/community.tsx',
      '../../../../app/(app)/beeline/corners/[roomId].tsx',
      '../../../../app/(app)/beeline/MembersScreen.tsx',
      '../../../../app/(app)/beeline/chat/[channelId].tsx',
      '../../../../app/(app)/join/[token].tsx',
    ];
    for (const relativePath of railScreens) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source, `${relativePath} mounts the rail`).toContain('onSettings=');
      expect(source, `${relativePath} skips the settings hub`).not.toContain(
        "onSettings={() => router.push('/beeline/settings/identity'",
      );
      expect(source, `${relativePath} should open the hub`).toContain(
        "onSettings={() => router.push('/beeline/settings' as Href)}",
      );
    }
    // ...and the hub itself is the only thing that opens the identity screen.
    const renderer = render();
    expect(renderer.root.findByProps({ testID: 'backup-key-setting' })).toBeDefined();
  });

  it('renders as an index, not a stack of cards', () => {
    // DESIGN.md: a box never wraps a repeating content unit. Every row on this
    // screen is the shared `SettingsRow`, which owns the hairline; the one box
    // left here is the destructive confirmation, a non-repeating notice.
    const source = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');
    const rowSource = readFileSync(
      new URL('../../../../components/buzz/SettingsRow.tsx', import.meta.url),
      'utf8',
    );
    const rowStyle = rowSource.slice(rowSource.indexOf('    row: {'));
    const rowBlock = rowStyle.slice(0, rowStyle.indexOf('},') + 2);
    expect(rowBlock).not.toMatch(/borderWidth|borderRadius|backgroundColor/);
    expect(rowBlock).toMatch(/borderBottomWidth: StyleSheet\.hairlineWidth/);
    expect(rowBlock).toMatch(/borderBottomColor: hull\.border/);
    // No screen-local row shape stands beside the shared one.
    expect(source).not.toMatch(/settingsRow|rowGutter|forgetGlyph|manageText/);
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
    expect(navigation.push).toHaveBeenCalledWith('/beeline/settings/identity');

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
    expect(navigation.push).toHaveBeenCalledWith('/beeline/settings/identity');
    await act(async () => {
      await renderer.root.findByProps({ testID: 'sign-out-setting' }).props.onPress();
    });
    expect(identityStorage.clearBuzzIdentity).toHaveBeenCalledOnce();
    expect(authSession.clearPendingGitHubSignInState).toHaveBeenCalledOnce();
    expect(surfaceStorage.clearMobileSurfaceStorage).toHaveBeenCalledOnce();
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/onboarding');
  });

  describe('Delete account', () => {
    const screenText = (renderer: ReactTestRenderer) =>
      renderer.root
        .findAllByType('Text' as any)
        .flatMap((node) => node.props.children)
        .join(' ');

    it('asks first and names what is deleted and what remains', () => {
      const renderer = render();
      expect(renderer.root.findByProps({ testID: 'delete-account-setting' }).props.title).toBe(
        'Delete account',
      );
      // One press only arms the confirmation.
      act(() => renderer.root.findByProps({ testID: 'delete-account-setting' }).props.onPress());
      expect(transport.deleteCalls).toBe(0);
      expect(renderer.root.findByProps({ testID: 'delete-account-setting' }).props.title).toBe(
        'Confirm delete account',
      );
      const warning = screenText(renderer);
      expect(warning).toContain('permanently deletes your account');
      // What goes.
      expect(warning).toContain('sessions and push devices');
      expect(warning).toContain('every agent you own');
      expect(warning).toContain('uploaded media');
      // What remains.
      expect(warning).toContain('attributed to');
      expect(warning).toContain('cannot be undone');
    });

    it('cancels without touching the account or the local identity', () => {
      const renderer = render();
      act(() => renderer.root.findByProps({ testID: 'delete-account-setting' }).props.onPress());
      act(() => renderer.root.findByProps({ testID: 'cancel-delete-account' }).props.onPress());
      expect(renderer.root.findAllByProps({ testID: 'cancel-delete-account' })).toHaveLength(0);
      expect(renderer.root.findByProps({ testID: 'delete-account-setting' }).props.title).toBe(
        'Delete account',
      );
      expect(transport.deleteCalls).toBe(0);
      expect(identityStorage.clearBuzzIdentity).not.toHaveBeenCalled();
      expect(navigation.replace).not.toHaveBeenCalled();
    });

    it('deletes the server account before clearing local state and landing on onboarding', async () => {
      identityStorage.loadBuzzIdentity.mockResolvedValue({
        secretKey: 'k'.repeat(64),
        publicKey: 'a'.repeat(64),
      });
      const renderer = render();
      await act(async () => {
        await renderer.root.findByProps({ testID: 'delete-account-setting' }).props.onPress();
      });
      await act(async () => {
        await renderer.root.findByProps({ testID: 'delete-account-setting' }).props.onPress();
      });
      // The server heard the deletion before any local state moved.
      expect(transport.deleteCalls).toBe(1);
      expect(identityStorage.clearBuzzIdentity).toHaveBeenCalledOnce();
      expect(authSession.clearPendingGitHubSignInState).toHaveBeenCalledOnce();
      expect(surfaceStorage.clearMobileSurfaceStorage).toHaveBeenCalledOnce();
      expect(navigation.replace).toHaveBeenCalledWith('/beeline/onboarding');
    });

    it('explains itself and stays actionable when deletion fails', async () => {
      transport.failDelete = true;
      identityStorage.loadBuzzIdentity.mockResolvedValue({
        secretKey: 'k'.repeat(64),
        publicKey: 'a'.repeat(64),
      });
      const renderer = render();
      await act(async () => {
        await renderer.root.findByProps({ testID: 'delete-account-setting' }).props.onPress();
      });
      await act(async () => {
        await renderer.root.findByProps({ testID: 'delete-account-setting' }).props.onPress();
      });
      const row = renderer.root.findByProps({ testID: 'delete-account-setting' }).props;
      expect(row.description).toContain('Deletion failed');
      expect(row.disabled).toBe(false);
      // Nothing local was lost: the account still holds the data.
      expect(identityStorage.clearBuzzIdentity).not.toHaveBeenCalled();
      expect(navigation.replace).not.toHaveBeenCalled();
    });
  });
});
