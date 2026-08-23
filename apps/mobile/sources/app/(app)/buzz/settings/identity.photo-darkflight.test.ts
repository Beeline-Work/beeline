import { readFileSync } from 'node:fs';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Photo-override darkflight (owner decision, 2026-08-23): identity marks are
// the ONLY avatars on the product surface. Every picture-setting UI gates on
// PHOTO_OVERRIDES_ENABLED; these tests pin both halves — no surface renders a
// picture affordance while the flag ships false, and the flag itself stays
// honest about what it gates.

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const client = vi.hoisted(() => ({
  listCommunities: vi.fn(async () => []),
  getGlobalPersonProfile: vi.fn(async () => ({
    name: 'Captain',
    avatar: 'https://example.test/captain.png',
  })),
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
  return { Svg: host('Svg'), Path: host('Path'), Rect: host('Rect'), Circle: host('Circle'), Polygon: host('Polygon'), G: host('G') };
});
vi.mock('@beeline/buzz-client', () => ({
  claimNip05Handle: vi.fn(),
  fallbackPersonName: (pubkey: string) => `Person ${pubkey.slice(0, 4)}`,
  lookupRecovery: vi.fn(async () => []),
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
  getBuzzRuntimeConfig: () => ({
    relayUrl: 'https://relay.test',
    pushGatewayUrl: 'https://push.test',
  }),
}));
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
    Share: { share: vi.fn() },
    Switch: host('Switch'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
    StyleSheet: { create: (styles: unknown) => styles, flatten: (s: unknown) => s },
  };
});

import IdentitySettingsScreen from './identity';
import { PHOTO_OVERRIDES_ENABLED } from '@/buzz/photo-overrides';

const originalConsoleError = console.error;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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

beforeEach(() => {
  vi.clearAllMocks();
  client.getGlobalPersonProfile.mockResolvedValue({
    name: 'Captain',
    avatar: 'https://example.test/captain.png',
  });
});

async function renderScreen(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(IdentitySettingsScreen));
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

function renderedText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType('Text')
    .map((node: any) =>
      typeof node.props.children === 'string' ? node.props.children : '',
    )
    .join(' ');
}

describe('photo-override darkflight on the settings surfaces', () => {
  it('ships with the flag off', () => {
    // The darkflight IS the flag. Flipping it revives every gated surface at
    // once — this assertion makes that flip a deliberate act, not an accident.
    expect(PHOTO_OVERRIDES_ENABLED).toBe(false);
  });

  it('gates every picture-setting surface in source', () => {
    const root = new URL('../../../../../', import.meta.url).pathname;
    const surfaces = [
      'sources/app/(app)/buzz/settings/identity.tsx',
      'sources/app/(app)/buzz/settings/workspace.tsx',
      'sources/app/(app)/buzz/MembersScreen.tsx',
    ];
    for (const relative of surfaces) {
      const source = readFileSync(`${root}${relative}`, 'utf8');
      expect(source, `${relative} must gate on PHOTO_OVERRIDES_ENABLED`).toContain(
        'PHOTO_OVERRIDES_ENABLED &&',
      );
    }
  });

  it('renders no picture-setting UI even when the profile carries a stored photo', async () => {
    const renderer = await renderScreen();

    const text = renderedText(renderer);
    expect(text).not.toContain('Your picture');
    expect(text).not.toContain('Set picture');
    expect(text).not.toContain('Change picture');
    expect(text).not.toContain('Use generated mark');
    expect(text).not.toContain('Cosmetic only');
    // pickAndUploadAvatar is unreachable from this surface.
    const { pickAndUploadAvatar } = await import('@/buzz/avatar-upload');
    expect(pickAndUploadAvatar).not.toHaveBeenCalled();
  });
});
