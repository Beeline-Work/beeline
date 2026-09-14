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
const runtime = vi.hoisted(() => ({ monolithEnabled: false }));
const phoneOperation = vi.hoisted(() => vi.fn());
const updates = vi.hoisted(() => ({ isEnabled: true }));

vi.mock('expo-router', () => ({ router: navigation, useLocalSearchParams: () => ({}) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-linking', () => ({
  createURL: (path: string) => `beeline://${path}`,
  addEventListener: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('expo-updates', () => ({
  get isEnabled() {
    return updates.isEnabled;
  },
  channel: null,
  updateId: null,
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));
vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: vi.fn(async () => []),
  dismissNotificationAsync: vi.fn(async () => undefined),
  setBadgeCountAsync: vi.fn(async () => true),
}));
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
  finishOidcBind: vi.fn(),
  fallbackPersonName: (pubkey: string) => `Person ${pubkey.slice(0, 4)}`,
  lookupRecovery: vi.fn(async () => []),
  lookupManagedIdentity: vi.fn(async () => null),
  normalizeNip05Identifier: (value: string) => value.trim().toLowerCase(),
  normalizePersonHandle: (value: string) => value.trim().toLowerCase() || null,
  normalizePersonName: (value: string) => value.trim() || null,
  personHandle: (name: string) => name.toLowerCase(),
  RoomViewClient: class {
    workspaces = vi.fn(async () => ({ workspaces: [] }));
  },
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
  getBuzzRuntimeConfig: () => ({
    relayUrl: 'https://relay.test',
    pushGatewayUrl: 'https://push.test',
    monolithEnabled: runtime.monolithEnabled,
  }),
}));
vi.mock('@/sync/appConfig', () => ({
  loadAppConfig: () => ({ releaseVersion: 'v0.2.19', releaseSha: 'abc123def4567890abcdef' }),
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
vi.mock('@/push/buzz-push-registration', () => pushModule);
vi.mock('@/push/push-level-storage', () => ({ saveStoredPushLevel: vi.fn(async () => undefined) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));
vi.mock('@/sync/pushRegistration', () => permissionInfo);
vi.mock('@/buzz/surface-storage', () => ({ clearMobileSurfaceStorage: vi.fn() }));
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

import IdentitySettingsScreen from './identity';

const RELEASE_VALUE = 'v0.2.19 · abc123def456';
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

/** One element of the rendered output tree, as `toJSON` hands it over. */
type Node = {
  type: string;
  props: Record<string, unknown>;
  children: (Node | string)[] | null;
};

function kids(node: Node): (Node | string)[] {
  return node.children ?? [];
}

/** The text an element puts on screen, joined as it reads. */
function spell(node: Node | string): string {
  if (typeof node === 'string') return node;
  return kids(node).map(spell).join('');
}

function flatStyle(node: Node): Record<string, unknown> {
  return Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean));
}

/** Every `Text` in a row, paired with the elements it is nested inside. */
function textsUnder(node: Node, ancestors: Node[] = []): { node: Node; ancestors: Node[] }[] {
  if (node.type === 'Text') return [{ node, ancestors }];
  return kids(node)
    .filter((child): child is Node => typeof child !== 'string')
    .flatMap((child) => textsUnder(child, [...ancestors, node]));
}

function rowElement(renderer: ReactTestRenderer, testID: string): Node {
  const walk = (node: Node | string): Node[] => {
    if (typeof node === 'string') return [];
    const here = node.props.testID === testID ? [node] : [];
    return [...here, ...kids(node).flatMap(walk)];
  };
  const matches = walk(renderer.toJSON() as Node);
  expect(matches, `no row ${testID}`).toHaveLength(1);
  return matches[0];
}

describe('the Settings version row reads label left, value right', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updates.isEnabled = true;
    runtime.monolithEnabled = false;
    pushModule.getBuzzPushEnabled.mockResolvedValue(true);
    pushModule.getBuzzPushRegistrationState.mockResolvedValue(null);
    permissionInfo.getPushPermissionInfo.mockResolvedValue({
      status: 'granted',
      granted: true,
      canAskAgain: true,
    });
  });

  it('puts the version and its build string on the trailing axis, as Handle does', async () => {
    const renderer = await renderScreen();

    // The row above: the label leads, its value is right-aligned beside it.
    const handleValue = textsUnder(rowElement(renderer, 'identity-managed-handle')).at(-1)!;
    expect(handleValue.ancestors).toHaveLength(1);
    expect(flatStyle(handleValue.node).textAlign).toBe('right');

    const versionTexts = textsUnder(rowElement(renderer, 'ota-update-info'));
    const value = versionTexts.find((text) => spell(text.node).includes(RELEASE_VALUE));
    expect(
      value,
      `no version value; row read: ${versionTexts.map((text) => spell(text.node))}`,
    ).toBeDefined();
    // Beside the label on the row's own axis — not stacked under it.
    expect(value!.ancestors).toHaveLength(1);
    expect(flatStyle(value!.node).textAlign).toBe('right');
    expect(spell(value!.node)).toBe(RELEASE_VALUE);
    expect(versionTexts.map((text) => spell(text.node))).toEqual([
      'Version',
      RELEASE_VALUE,
      'Check',
    ]);
  });

  it('keeps the update notice on the quiet line, with the value still on the axis', async () => {
    updates.isEnabled = false; // Updates are unavailable in this build.
    const renderer = await renderScreen();
    const versionTexts = textsUnder(rowElement(renderer, 'ota-update-info'));

    const notice = versionTexts.find((text) =>
      spell(text.node).includes('Updates are unavailable in this build.'),
    );
    expect(notice).toBeDefined();
    expect(notice!.ancestors.length).toBeGreaterThan(1); // under the label, in the copy column

    const value = versionTexts.find((text) => spell(text.node) === RELEASE_VALUE);
    expect(value).toBeDefined();
    expect(value!.ancestors).toHaveLength(1);
    expect(flatStyle(value!.node).textAlign).toBe('right');

    // The notice takes a line under the label; it never pushes the row's
    // action off the axis onto a line of its own.
    const row = rowElement(renderer, 'ota-update-info');
    expect(kids(row).filter((child) => typeof child !== 'string')).toHaveLength(3);
    expect(flatStyle(row).flexWrap).toBeUndefined();
  });

  it('gives the value the width its string needs, not half the row', async () => {
    const renderer = await renderScreen();
    const value = textsUnder(rowElement(renderer, 'ota-update-info')).find(
      (text) => spell(text.node) === RELEASE_VALUE,
    )!;
    // `flex: 1` would hand the value half the row and ellipsize the build
    // string; it takes the width the string needs and shrinks only past that.
    const style = flatStyle(value.node);
    expect(style.flex).toBeUndefined();
    expect(style.flexShrink).toBe(1);
  });
});
