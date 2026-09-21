import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Reproduction settings-identity-read-failure: the screen only revealed the
// identity tile once the whole profile read resolved, so any failure in that
// chain left the person looking at an error with no face and no handle. The
// device already holds the identity; the tile is drawn from it.

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const client = vi.hoisted(() => ({
  listCommunities: vi.fn(async () => []),
  getGlobalPersonProfile: vi.fn(async () => ({ name: 'Captain' })),
}));
const workspaceRead = vi.hoisted(() => ({
  workspaces: vi.fn(async () => ({ workspaces: [] as { id: string }[] })),
}));
const pushModule = vi.hoisted(() => ({
  getBuzzPushEnabled: vi.fn(async () => true),
  getBuzzPushRegistrationState: vi.fn(async () => null),
  registerBuzzPushNotifications: vi.fn(),
  setBuzzPushEnabled: vi.fn(),
}));
const permissionInfo = vi.hoisted(() => ({
  getPushPermissionInfo: vi.fn(async () => ({
    status: 'granted',
    granted: true,
    canAskAgain: true,
  })),
}));
const runtime = vi.hoisted(() => ({ monolithEnabled: false }));
const phoneOperation = vi.hoisted(() => vi.fn());
const notificationApi = vi.hoisted(() => ({
  getPresentedNotificationsAsync: vi.fn(async () => []),
  dismissNotificationAsync: vi.fn(async () => undefined),
  setBadgeCountAsync: vi.fn(async () => true),
}));

vi.mock('expo-router', () => ({ router: navigation, useLocalSearchParams: () => ({}) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-linking', () => ({
  createURL: (path: string) => `beeline://${path}`,
  addEventListener: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('expo-updates', () => ({
  isEnabled: false,
  channel: null,
  updateId: null,
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));
vi.mock('expo-notifications', () => notificationApi);
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(async () => undefined),
  NotificationFeedbackType: { Success: 'SUCCESS', Warning: 'WARNING', Error: 'ERROR' },
}));
vi.mock('expo-local-authentication', () => ({
  hasHardwareAsync: vi.fn(async () => false),
  isEnrolledAsync: vi.fn(async () => false),
  supportedAuthenticationTypesAsync: vi.fn(async () => []),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('qrcode', () => ({ create: vi.fn(() => ({ modules: { size: 0, get: () => 0 } })) }));
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: unknown) => ReactModule.createElement(name, props);
  return {
    default: host('Svg'),
    Svg: host('Svg'),
    Path: host('Path'),
    Rect: host('Rect'),
    Circle: host('Circle'),
    Polygon: host('Polygon'),
    Polyline: host('Polyline'),
  };
});
vi.mock('@beeline/buzz-client', () => ({
  adoptGitHubHandle: vi.fn(),
  buildOidcBindEvent: vi.fn(),
  finishOidcBind: vi.fn(),
  fallbackPersonName: (pubkey: string) => `Person ${pubkey.slice(0, 4)}`,
  lookupRecovery: vi.fn(async () => []),
  lookupManagedIdentity: vi.fn(async () => null),
  normalizeNip05Identifier: (value: string) => value.trim().toLowerCase(),
  normalizePersonHandle: (value: string) => value.trim().toLowerCase() || null,
  normalizePersonName: (value: string) => value.trim() || null,
  personHandle: (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, ''),
  startGitHubBind: vi.fn(),
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspaces = workspaceRead.workspaces;
  },
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  clearBuzzIdentity: vi.fn(async () => undefined),
  loadBuzzIdentity: vi.fn(async () => ({
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32).fill(1),
  })),
  loadBuzzIdentityNsecForExport: vi.fn(async () => 'nsec1test'),
}));
vi.mock('@/buzz/community-storage', () => ({ loadActiveCommunityId: vi.fn(async () => null) }));
vi.mock('@/buzz/avatar-upload', () => ({ pickAndUploadAvatar: vi.fn() }));
vi.mock('@/buzz/nip05-verification', () => ({ useVerifiedNip05Status: () => 'unverified' }));
vi.mock('@/buzz/person-name', () => ({
  ensurePersonNameForWorkspace: vi.fn(async () => ({ name: 'Captain' })),
  loadPreferredPersonName: vi.fn(async () => 'Captain'),
  savePreferredPersonName: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({
    relayUrl: 'https://relay.test',
    pushGatewayUrl: 'https://push.test',
    monolithEnabled: runtime.monolithEnabled,
  }),
}));
vi.mock('@/sync/appConfig', () => ({
  loadAppConfig: () => ({ releaseVersion: 'v0.0.1', releaseSha: null }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: unknown) => ReactModule.createElement(name, props);
  return {
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
    HullSurface: host('HullSurface'),
    MonoButton: host('MonoButton'),
    PixelGateReveal: host('PixelGateReveal'),
    PixelLoader: host('PixelLoader'),
  };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: unknown) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/components/buzz/FacePickerSheet', async () => {
  const ReactModule = await import('react');
  return {
    FacePickerSheet: (props: unknown) => ReactModule.createElement('FacePickerSheet', props),
  };
});
vi.mock('@/components/buzz/BeelineMark', async () => {
  const ReactModule = await import('react');
  return { BeelineMark: (props: unknown) => ReactModule.createElement('BeelineMark', props) };
});
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn(async () => undefined) }));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => client);
  },
}));
vi.mock('@/components/buzz/PushLevelSetting', async () => {
  const ReactModule = await import('react');
  return {
    PushLevelSetting: (props: unknown) =>
      ReactModule.createElement('PushLevelSetting', {
        ...(props as object),
        testID: 'push-level-setting',
      }),
  };
});
vi.mock('@/components/buzz/AppearanceSetting', async () => {
  const ReactModule = await import('react');
  return {
    AppearanceSetting: (props: unknown) =>
      ReactModule.createElement('AppearanceSetting', {
        ...(props as object),
        testID: 'appearance-setting',
      }),
  };
});
vi.mock('@/components/buzz/UiSizeSetting', async () => {
  const ReactModule = await import('react');
  return {
    UiSizeSetting: (props: unknown) =>
      ReactModule.createElement('UiSizeSetting', {
        ...(props as object),
        testID: 'ui-size-setting',
      }),
  };
});
vi.mock('@/components/buzz/SettingsRow', async () => {
  const ReactModule = await import('react');
  return {
    SettingsRow: (props: unknown) => ReactModule.createElement('SettingsRow', props as never),
  };
});
vi.mock('@/unistyles', () => ({ applyAppearanceChoice: vi.fn(), setAppDisplay: vi.fn() }));
vi.mock('@/sync/storage', () => ({
  useLocalSettingMutable: (name: string) => [name === 'appearance' ? 'dark' : 'medium', vi.fn()],
}));
vi.mock('@/push/buzz-push-registration', () => pushModule);
vi.mock('@/push/push-level-storage', () => ({ saveStoredPushLevel: vi.fn(async () => undefined) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));
vi.mock('@/sync/pushRegistration', () => permissionInfo);
vi.mock('@/buzz/surface-storage', () => ({ clearMobileSurfaceStorage: vi.fn() }));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (styles: unknown) =>
      typeof styles === 'function'
        ? (styles as (theme: unknown) => unknown)({ buzz: beelineThemes.obsidian })
        : styles,
  },
  useUnistyles: () => ({
    theme: { buzz: { textPrimary: '#fff', bgRaised: '#111', chrome: '#d7af5f' } },
  }),
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: unknown) =>
    ReactModule.createElement(name, props as never);
  return {
    Platform: { OS: 'web', select: (choices: Record<string, unknown>) => choices.default },
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    ScrollView: host('ScrollView'),
    Switch: host('Switch'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    StyleSheet: { create: (styles: unknown) => styles, flatten: (s: unknown) => s },
  };
});

// The theme has to be live before the screen evaluates, because the mocked
// StyleSheet.create calls the screen's theme-taking factory as it imports.
import { beelineThemes } from '@/buzz/groknight';
import IdentitySettingsScreen from './identity';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (
      typeof message === 'string' &&
      (message.startsWith('react-test-renderer is deprecated') || message.includes('act('))
    ) {
      return;
    }
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

async function renderScreen(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(IdentitySettingsScreen));
  });
  return renderer;
}

function headings(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text')
    .map((node: { props: { children?: unknown } }) => node.props.children)
    .filter((value: unknown): value is string => typeof value === 'string');
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.monolithEnabled = false;
  workspaceRead.workspaces.mockResolvedValue({ workspaces: [] });
  client.getGlobalPersonProfile.mockResolvedValue({ name: 'Captain' });
  pushModule.getBuzzPushEnabled.mockResolvedValue(true);
  pushModule.getBuzzPushRegistrationState.mockResolvedValue(null);
  permissionInfo.getPushPermissionInfo.mockResolvedValue({
    status: 'granted',
    granted: true,
    canAskAgain: true,
  });
});

describe('Reproduction settings-identity-read-failure', () => {
  it('keeps the identity tile when the workspace read fails', async () => {
    workspaceRead.workspaces.mockRejectedValue(new Error('relay unreachable'));
    const renderer = await renderScreen();

    await vi.waitFor(() =>
      expect(renderer.root.findAllByProps({ testID: 'identity-settings' }).length).toBeGreaterThan(
        0,
      ),
    );
    expect(renderer.root.findByProps({ testID: 'identity-face-setting' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'identity-face-mark' }).props.seed).toBe(
      'a'.repeat(64),
    );
    expect(renderer.root.findByProps({ testID: 'identity-managed-handle' })).toBeDefined();
  });

  it('keeps the identity tile when the profile read fails', async () => {
    client.getGlobalPersonProfile.mockRejectedValue(new Error('profile read failed'));
    const renderer = await renderScreen();

    await vi.waitFor(() =>
      expect(renderer.root.findAllByProps({ testID: 'identity-settings' }).length).toBeGreaterThan(
        0,
      ),
    );
    expect(renderer.root.findByProps({ testID: 'identity-face-mark' }).props.name).toBe(
      'Person aaaa',
    );
  });

  it('still reports the failure next to the tile', async () => {
    client.getGlobalPersonProfile.mockRejectedValue(new Error('profile read failed'));
    const renderer = await renderScreen();

    await vi.waitFor(() =>
      expect(
        headings(renderer).some((text) => text.startsWith('Could not load your profile')),
      ).toBe(true),
    );
  });

  it('shows the real profile name once the read succeeds', async () => {
    const renderer = await renderScreen();
    await vi.waitFor(() =>
      expect(renderer.root.findByProps({ testID: 'identity-face-mark' }).props.name).toBe(
        'Captain',
      ),
    );
  });
});

describe('Settings groups', () => {
  it('heads the device controls Device and the account run Account', async () => {
    const renderer = await renderScreen();
    const texts = headings(renderer);
    expect(texts).toContain('Device');
    expect(texts).toContain('Account');
  });

  it('heads the Workbench row Workbench when the Workbench is available', async () => {
    runtime.monolithEnabled = true;
    phoneOperation.mockResolvedValue({
      face: null,
      pushLevel: 'mine',
      handle: null,
      name: 'Captain',
    });
    const renderer = await renderScreen();
    const texts = headings(renderer);
    expect(texts).toContain('Workbench');
    expect(texts).toContain('Device');
    expect(texts).toContain('Account');
  });

  it('files privacy, terms and feedback under Account, above the destructive rows', async () => {
    const renderer = await renderScreen();
    const account = renderer.root.findByProps({ testID: 'account-settings' });
    const rows = account
      .findAllByType('SettingsRow')
      .map((node: { props: { testID?: string } }) => node.props.testID);
    expect(rows).toEqual([
      'settings-privacy-row',
      'settings-terms-row',
      'settings-feedback-row',
      'sign-out-setting',
      'delete-account-setting',
    ]);
  });
});
