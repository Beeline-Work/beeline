import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const auth = vi.hoisted(() => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => null),
  loadBuzzIdentityNsecForExport: vi.fn(async () => null),
}));

vi.mock('expo-router', () => ({ router: navigation }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('expo-haptics', () => ({ impactAsync: vi.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
vi.mock('expo-local-authentication', () => ({
  authenticateAsync: vi.fn(async () => ({ success: false })),
  hasHardwareAsync: vi.fn(async () => false),
  isEnrolledAsync: vi.fn(async () => false),
  supportedAuthenticationTypesAsync: vi.fn(async () => []),
  AuthenticationType: { FACIAL_RECOGNITION: 2, FINGERPRINT: 1 },
}));
vi.mock('qrcode', () => ({ create: () => ({ modules: { size: 0, get: () => 0 } }) }));
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { default: host('Svg'), Path: host('Path'), Rect: host('Rect') };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/auth/buzz-identity-storage', () => auth);
vi.mock('@/buzz/community-storage', () => ({ loadActiveCommunityId: vi.fn(async () => null) }));
vi.mock('@/buzz/avatar-upload', () => ({ pickAndUploadAvatar: vi.fn() }));
vi.mock('@/buzz/nip05-verification', () => ({ useVerifiedNip05Status: () => 'idle' }));
vi.mock('@/buzz/person-name', () => ({
  ensurePersonNameForWorkspace: vi.fn(async () => null),
  loadPreferredPersonName: vi.fn(async () => null),
  savePreferredPersonName: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ authUrl: null }) }));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => ({}));
  },
}));
vi.mock('@/push/buzz-push-registration', () => ({
  getBuzzPushEnabled: vi.fn(async () => false),
  setBuzzPushEnabled: vi.fn(async () => undefined),
}));
vi.mock('@/sync/pushRegistration', () => ({ getPushPermissionInfo: vi.fn(async () => null) }));
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    HullSurface: host('HullSurface'),
    MonoButton: host('MonoButton'),
    PixelGateReveal: host('PixelGateReveal'),
  };
});
vi.mock('@/components/buzz/PersonAvatar', async () => {
  const ReactModule = await import('react');
  return { PersonAvatar: (props: any) => ReactModule.createElement('PersonAvatar', props) };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles },
    Switch: host('Switch'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

import BuzzIdentitySettings from './identity';

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
beforeEach(() => vi.clearAllMocks());

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(BuzzIdentitySettings));
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('My Settings', () => {
  // THROWAWAY TYPE EXPLORATION — delete alongside @/buzz/font-exploration.
  //
  // The toggle first landed on the settings hub (settings/index.tsx), which no
  // entry point in the app actually opens — every `onSettings` handler pushes
  // straight to this screen — so it was unreachable on-device. It has to be
  // reachable from HERE, and this test is what says so.
  it('reaches the type-direction exploration from the screen every entry point opens', async () => {
    const renderer = await render();

    const row = renderer.root.findByProps({ testID: 'type-direction-setting' });
    const labels = renderer.root
      .findAllByType('Text' as any)
      .flatMap((node) => node.props.children)
      .filter((child: unknown) => typeof child === 'string');

    expect(labels).toContain('Type direction');
    expect(labels).toContain('TYPE EXPLORATION');

    act(() => row.props.onPress());
    expect(navigation.push).toHaveBeenCalledWith('/buzz/settings/fonts');
  });
});
