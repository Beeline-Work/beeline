import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const client = vi.hoisted(() => ({
  listCommunities: vi.fn(async () => []),
  getGlobalPersonProfile: vi.fn(async () => ({ name: 'Captain' })),
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

vi.mock('expo-router', () => ({ router: navigation }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-linking', () => ({
  createURL: (path: string) => `beeline://${path}`,
  addEventListener: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
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
  return { Svg: host('Svg'), Path: host('Path'), Rect: host('Rect') };
});
vi.mock('@beeline/buzz-client', () => ({
  adoptGitHubHandle: vi.fn(),
  buildOidcBindEvent: vi.fn(),
  claimNip05Handle: vi.fn(),
  finishOidcBind: vi.fn(),
  fallbackPersonName: (pubkey: string) => `Person ${pubkey.slice(0, 4)}`,
  lookupRecovery: vi.fn(async () => []),
  lookupManagedIdentity: vi.fn(async () => null),
  Nip05ClaimError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  normalizeNip05Identifier: (value: string) => value.trim().toLowerCase(),
  normalizePersonHandle: (value: string) => value.trim().toLowerCase() || null,
  normalizePersonName: (value: string) => value.trim() || null,
  personHandle: (name: string) => name.toLowerCase(),
  startGitHubBind: vi.fn(),
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
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
  getBuzzRuntimeConfig: () => ({ relayUrl: 'https://relay.test', pushGatewayUrl: 'https://push.test' }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/constants/Typography', () => ({
  Typography: {
    default: () => ({}),
    mono: () => ({}),
  },
}));
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: unknown) => ReactModule.createElement(name, props);
  return {
    HullSurface: host('HullSurface'),
    MonoButton: host('MonoButton'),
    PixelGateReveal: host('PixelGateReveal'),
  };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: unknown) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => client);
  },
}));
vi.mock('@/push/buzz-push-registration', () => pushModule);
vi.mock('@/sync/pushRegistration', () => permissionInfo);
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
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
    AppState: {
      addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
    ScrollView: host('ScrollView'),
    Switch: host('Switch'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
    StyleSheet: { create: (styles: unknown) => styles, flatten: (s: unknown) => s },
  };
});

import IdentitySettingsScreen from './identity';

const originalConsoleError = console.error;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (
      typeof message === 'string' &&
      (message.startsWith('react-test-renderer is deprecated') ||
        message.includes('act('))
    ) {
      return;
    }
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

function registrationState(overrides: Record<string, unknown>) {
  return { registered: false, retryable: true, phase: 'registered', failedAttempts: 1, updatedAt: Date.now(), ...overrides };
}

async function renderScreen(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(IdentitySettingsScreen));
  });
  return renderer;
}

function toggle(renderer: ReactTestRenderer): { value: boolean } & Record<string, unknown> {
  return renderer.root.findByProps({ testID: 'push-notifications-toggle' }).props;
}

function subtitleText(renderer: ReactTestRenderer): string {
  const section = renderer.root.findByProps({ testID: 'notifications-setting' });
  return section
    .findAllByType('Text')
    .map((node: { props: { children?: unknown } }) =>
      typeof node.props.children === 'string' ? node.props.children : '',
    )
    .join(' ');
}

describe('identity settings push row honesty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushModule.getBuzzPushEnabled.mockResolvedValue(true);
    pushModule.getBuzzPushRegistrationState.mockResolvedValue(null);
    permissionInfo.getPushPermissionInfo.mockResolvedValue({
      status: 'granted',
      granted: true,
      canAskAgain: true,
    });
  });

  it('shows a truthful off switch and failure line when registration failed, and retries on demand', async () => {
    // Forced failure: token acquisition timed out on last launch.
    pushModule.getBuzzPushRegistrationState.mockResolvedValue(
      registrationState({ phase: 'token-timed-out' }),
    );
    pushModule.registerBuzzPushNotifications.mockResolvedValue(
      registrationState({ registered: true, retryable: false, phase: 'registered' }),
    );
    const renderer = await renderScreen();

    expect(toggle(renderer).value).toBe(false);
    expect(subtitleText(renderer)).toContain('device token timed out');
    expect(subtitleText(renderer)).toContain('will retry');

    // The user taps RETRY NOW; this time the gateway accepts.
    await act(async () => {
      renderer.root.findByProps({ testID: 'push-retry-registration' }).props.onPress();
    });

    expect(pushModule.registerBuzzPushNotifications).toHaveBeenCalledTimes(1);
    expect(toggle(renderer).value).toBe(true);
    expect(subtitleText(renderer)).toContain('OS permission: allowed');
  });

  it('shows the switch on only when the stored state says registered', async () => {
    pushModule.getBuzzPushRegistrationState.mockResolvedValue(
      registrationState({ registered: true, retryable: false, phase: 'registered', failedAttempts: 0 }),
    );
    const renderer = await renderScreen();

    expect(toggle(renderer).value).toBe(true);
    expect(subtitleText(renderer)).toContain('OS permission: allowed');
    expect(renderer.root.findAllByProps({ testID: 'push-retry-registration' })).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ testID: 'push-send-test-notification' }),
    ).toHaveLength(0);
  });

  it('never renders a push test action on any registration state', async () => {
    // Registered (previously showed "Send test notification")…
    pushModule.getBuzzPushRegistrationState.mockResolvedValue(
      registrationState({ registered: true, retryable: false, phase: 'registered', failedAttempts: 0 }),
    );
    const registered = await renderScreen();
    expect(
      registered.root.findAllByProps({ testID: 'push-send-test-notification' }),
    ).toHaveLength(0);

    // …and unregistered / failed states.
    const failed = await renderScreen();
    expect(failed.root.findAllByProps({ testID: 'push-send-test-notification' })).toHaveLength(0);
  });

  it('toggling on reflects the registration result, not just the request', async () => {
    // Push starts off. The user flips the switch on, but the gateway rejects.
    pushModule.getBuzzPushRegistrationState.mockResolvedValue(null);
    pushModule.getBuzzPushEnabled
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    pushModule.setBuzzPushEnabled.mockResolvedValue(
      registrationState({ phase: 'gateway-rejected' }),
    );
    const renderer = await renderScreen();
    expect(toggle(renderer).value).toBe(false);

    await act(async () => {
      toggle(renderer).onValueChange(true);
    });

    expect(pushModule.setBuzzPushEnabled).toHaveBeenCalledWith(expect.anything(), true);
    expect(toggle(renderer).value).toBe(false);
    expect(subtitleText(renderer)).toContain('push gateway refused registration');
  });
});
