vi.mock('@/components/buzz/WorkspaceSettingsPanel', async () => { const React = await import('react'); return { WORKSPACE_VISIBILITY_LABELS: { public: 'Public', 'invite-only': 'Invite-only' }, default: React.forwardRef((props: object, _ref) => React.createElement('WorkspaceSettings', props)) }; });
vi.mock('@expo/vector-icons', async () => { const R = await import('react'); return { Ionicons: (props: any) => R.createElement('Ionicons', props) }; });
vi.mock('react-native-keyboard-controller', async () => { const R = await import('react'); return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) }; });
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Reproduction R-1: Settings read the Workbench once on mount. Opened before
// the Workbench's vault sync, the "Tools and keys" row showed 0 and stayed 0
// after the Workbench listed keys, until Settings was closed and reopened.

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
const phoneOperation = vi.hoisted(() => vi.fn());
const notificationApi = vi.hoisted(() => ({
  getPresentedNotificationsAsync: vi.fn(async () => []),
  dismissNotificationAsync: vi.fn(async () => undefined),
  setBadgeCountAsync: vi.fn(async () => true),
}));
const account = vi.hoisted(() => ({
  signOut: vi.fn(async () => undefined),
  clearSession: vi.fn(async () => undefined),
  clearIdentity: vi.fn(async () => undefined),
  clearGitHub: vi.fn(async () => undefined),
  clearSurface: vi.fn(),
  deleteAccount: vi.fn(async () => undefined),
}));

const focus = vi.hoisted(() => ({ refocus: undefined as undefined | (() => void) }));
const workbench = vi.hoisted(() => ({ readWorkbench: vi.fn() }));
const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));

// Focus is a counter the test bumps: each bump re-runs the effect, the way
// expo-router runs a focus effect again when the screen regains focus.
vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => routeParams.value,
  useFocusEffect: (effect: () => void | (() => void)) => {
    const [generation, setGeneration] = React.useState(0);
    focus.refocus = () => setGeneration((value) => value + 1);
    React.useEffect(effect, [effect, generation]);
  },
}));
vi.mock('@/buzz/workbench-source', () => ({
  getWorkbenchSource: () => workbench,
  MonolithWorkbenchSource: class {
    readWorkbench(_scope: unknown, supplied: unknown) { return Promise.resolve(supplied); }
  },
}));
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
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: { clear: account.clearSession, signOut: account.signOut },
}));
vi.mock('@/auth/github-auth-session', () => ({
  clearPendingGitHubSignInState: account.clearGitHub,
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
  isWorkspaceListView: () => true,
  isWorkspaceView: (value: any) => Array.isArray(value?.members),
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
  clearBuzzIdentity: account.clearIdentity,
  loadBuzzIdentity: vi.fn(async () => ({
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32).fill(1),
  })),
}));
vi.mock('@/buzz/community-storage', () => ({
  loadActiveCommunityId: vi.fn(async () => null),
  watchActiveCommunityId: vi.fn((_pubkey: string, listener: (id: string | null) => void) => {
    void Promise.resolve(null).then(listener);
    return () => undefined;
  }),
}));
vi.mock('@/buzz/avatar-upload', () => ({ pickAndUploadAvatar: vi.fn() }));
vi.mock('@/buzz/person-name', () => ({
  loadPreferredPersonName: vi.fn(async () => 'Captain'),
  savePreferredPersonName: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({
    relayUrl: 'https://relay.test',
    pushGatewayUrl: 'https://push.test',
  }),
}));
vi.mock('@/sync/appConfig', () => ({
  loadAppConfig: () => ({ releaseVersion: 'v0.0.1', releaseSha: null }),
}));
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: unknown) => ReactModule.createElement(name, props);
  return {
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
    HullSurface: host('HullSurface'),
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
    deleteAccount = account.deleteAccount;
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
vi.mock('@/push/push-level-storage', () => ({
  saveStoredPushLevel: vi.fn(async () => undefined),
  watchStoredPushLevel: () => () => undefined,
}));
vi.mock('@/buzz/identity-live', () => ({ subscribeOwnIdentityChange: () => () => undefined }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));
vi.mock('@/sync/pushRegistration', () => permissionInfo);
vi.mock('@/buzz/surface-storage', async () => ({
  ...(await import('@/test/mock-surface-storage')).mockSurfaceStorage(),
  clearMobileSurfaceStorage: account.clearSurface,
}));
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
    Pressable: host('Pressable'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    StyleSheet: { create: (styles: unknown) => styles, flatten: (s: unknown) => s },
  };
});

// The theme has to be live before the screen evaluates, because the mocked
// StyleSheet.create calls the screen's theme-taking factory as it imports.
import { beelineThemes } from '@/buzz/groknight';
import { companyWorkbench } from '@/test/company-workbench';
import type { WorkbenchView } from '@/buzz/workbench';
import IdentitySettingsScreen from './identity';
import { mobileSurfaceCache } from '@/buzz/surface-storage';

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

const VIEWER = 'a'.repeat(64);

function view(value: string, attention = '1 company needs attention'): WorkbenchView {
  const answer = companyWorkbench();
  return { ...answer, companies: { ...answer.companies!, summary: { value, attention } } };
}

function workbenchRow(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({ testID: 'settings-workbench-row' });
}

async function refocus(): Promise<void> {
  await act(async () => {
    focus.refocus?.();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mobileSurfaceCache.clear();
  workspaceRead.workspaces.mockResolvedValue({ workspaces: [{ id: 'workspace-1' }] });
  client.getGlobalPersonProfile.mockResolvedValue({ name: 'Captain' });
  pushModule.getBuzzPushEnabled.mockResolvedValue(true);
  pushModule.getBuzzPushRegistrationState.mockResolvedValue(null);
  permissionInfo.getPushPermissionInfo.mockResolvedValue({
    status: 'granted',
    granted: true,
    canAskAgain: true,
  });
  phoneOperation.mockImplementation(async (name: string) => name === 'readIdentitySettings'
    ? { identity: { personId: VIEWER, face: null, pushLevel: 'attention', handle: null, name: 'C' },
        workspaces: { workspaces: [{ id: 'workspace-1', role: 'owner' }] },
        workbench: await workbench.readWorkbench() }
    : {});
});

describe('Settings Workbench row shares the held Workbench projection', () => {
  it('shows the updated server summary when the owner changes and does not re-read on focus', async () => {
    workbench.readWorkbench
      .mockResolvedValueOnce(view('0 connections', ''))
      .mockResolvedValue(view('2 connections'));
    const renderer = await renderScreen();
    await vi.waitFor(() => expect(workbenchRow(renderer).props.value).toBe('0 connections'));

    await act(async () => { await mobileSurfaceCache.write({ relayOrigin: 'https://relay.test',
      viewerPubkey: VIEWER, endpoint: '/workspace/:id/workbench',
      params: { workspaceId: 'workspace-1', viewerId: VIEWER } }, view('2 connections'),
      (value): value is WorkbenchView => Boolean(value)); });
    await refocus();

    await vi.waitFor(() => expect(workbenchRow(renderer).props.value).toBe('2 connections'));
    expect(workbench.readWorkbench).toHaveBeenCalledTimes(1);
  });

  it('states one total of the Your connections rows, not keys apart', async () => {
    workbench.readWorkbench.mockResolvedValue(view('3 connections'));
    const renderer = await renderScreen();
    await vi.waitFor(() => expect(workbenchRow(renderer).props.value).toBe('3 connections'));
    expect(workbenchRow(renderer).props.wholeTitle).toBe(true);
  });

  it('uses the server attention line in a danger subtitle', async () => {
    workbench.readWorkbench.mockResolvedValue(view('2 connections'));
    const renderer = await renderScreen();
    await vi.waitFor(() => expect(workbenchRow(renderer).props.value).toBe('2 connections'));
    expect(workbenchRow(renderer).props).toMatchObject({
      title: 'Your connections',
      chevron: 'right',
      description: '1 company needs attention',
      descriptionTone: 'danger',
    });
  });

  it('keeps the last value and shows no error on refocus', async () => {
    workbench.readWorkbench
      .mockResolvedValueOnce(view('2 connections'))
      .mockRejectedValue(new Error('offline'));
    const renderer = await renderScreen();
    await vi.waitFor(() => expect(workbenchRow(renderer).props.value).toBe('2 connections'));

    await refocus();

    expect(workbench.readWorkbench).toHaveBeenCalledTimes(1);
    expect(workbenchRow(renderer).props.value).toBe('2 connections');
    expect(workbenchRow(renderer).props.description).toBe('1 company needs attention');
    expect(headings(renderer).some((text) => text.startsWith('Could not load'))).toBe(false);
  });

  it('shows no value when the first read fails, and the row still opens the Workbench', async () => {
    workbench.readWorkbench.mockResolvedValue(undefined);
    const renderer = await renderScreen();
    await vi.waitFor(() => expect(workbench.readWorkbench).toHaveBeenCalled());
    expect(workbenchRow(renderer).props.value).toBeUndefined();
    expect(workbenchRow(renderer).props.description).toBeUndefined();
    act(() => workbenchRow(renderer).props.onPress());
    expect(navigation.push).toHaveBeenCalledWith({
      pathname: '/beeline/settings/workbench',
      params: { workspaceId: 'workspace-1', viewerId: VIEWER },
    });
  });
});

describe('Settings account actions', () => {
  it('signs out on the first tap and keeps every local cleanup step', async () => {
    const renderer = await renderScreen();
    await act(async () =>
      renderer.root.findByProps({ testID: 'sign-out-setting' }).props.onPress(),
    );
    expect(account.signOut).toHaveBeenCalledOnce();
    expect(account.clearSession).not.toHaveBeenCalled();
    expect(account.clearIdentity).toHaveBeenCalledOnce();
    expect(account.clearGitHub).toHaveBeenCalledOnce();
    expect(account.clearSurface).toHaveBeenCalledOnce();
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/onboarding');
    expect(headings(renderer)).not.toContain('Remove this identity from this device?');
  });

  it('shows the exact delete prompt with visible Yes and Cancel before deleting', async () => {
    const renderer = await renderScreen();
    await act(async () =>
      renderer.root.findByProps({ testID: 'delete-account-setting' }).props.onPress(),
    );
    expect(headings(renderer)).toContain(
      'deleting your account will delete all your data. this action is irrevocable. confirm?',
    );
    expect(renderer.root.findByProps({ testID: 'delete-account-yes' }).props.disabled).toBe(false);
    expect(renderer.root.findByProps({ testID: 'delete-account-cancel' }).props.disabled).toBe(
      false,
    );
    expect(headings(renderer)).toContain('Delete account');
    expect(headings(renderer)).toContain('Cancel');
    expect(account.deleteAccount).not.toHaveBeenCalled();
    await act(async () =>
      renderer.root.findByProps({ testID: 'delete-account-setting' }).props.onPress(),
    );
    expect(account.deleteAccount).not.toHaveBeenCalled();

    await act(async () =>
      renderer.root.findByProps({ testID: 'delete-account-cancel' }).props.onPress(),
    );
    expect(account.deleteAccount).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'delete-account-yes' })).toHaveLength(0);

    await act(async () =>
      renderer.root.findByProps({ testID: 'delete-account-setting' }).props.onPress(),
    );
    await act(async () =>
      renderer.root.findByProps({ testID: 'delete-account-yes' }).props.onPress(),
    );
    expect(account.deleteAccount).toHaveBeenCalledOnce();
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/onboarding');
  });
});

describe('Workspace tab in Settings', () => {
  function respond(role: 'owner' | 'admin' | 'member') {
    workbench.readWorkbench.mockResolvedValue(view('2 connections'));
    phoneOperation.mockImplementation(async (name: string) => name === 'readIdentitySettings'
      ? { identity: { personId: VIEWER, face: null, pushLevel: 'attention', handle: null, name: 'Captain' },
          workspaces: { workspaces: [{ id: 'workspace-1', name: 'Beeline', role, visibility: 'public' }] },
          workbench: await workbench.readWorkbench() }
      : {});
  }

  it.each(['owner', 'admin'] as const)('replaces the Workspace row with a tab for a %s', async (role) => {
    respond(role);
    const renderer = await renderScreen();
    expect(renderer.root.findAllByProps({ testID: 'settings-workspace-row' })).toHaveLength(0);
    expect(renderer.root.findAllByType('WorkspaceSettings')).toHaveLength(0);
    expect(headings(renderer)).toEqual(expect.arrayContaining(['CONNECTORS', 'DEVICE', 'ACCOUNT']));

    const tab = renderer.root.findByProps({ testID: 'settings-workspace-tab' });
    expect(tab.props.accessibilityState).toEqual({ selected: false });
    act(() => tab.props.onPress());

    expect(renderer.root.findByProps({ testID: 'settings-workspace-tab' }).props.accessibilityState)
      .toEqual({ selected: true });
    expect(renderer.root.findByType('WorkspaceSettings').props.workspaceId).toBe('workspace-1');
    expect(headings(renderer)).not.toContain('CONNECTORS');
    const caption = renderer.root.findByProps({ testID: 'settings-scope-caption' });
    const spoken = (node: any): string => typeof node === 'string' ? node
      : (node?.children ?? []).map(spoken).join('');
    expect(spoken(caption)).toContain(`Public workspace · you are ${role}`);
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('opens on the workspace tab from an old Workspace settings link', async () => {
    respond('owner');
    routeParams.value = { tab: 'workspace', workspaceId: 'workspace-1' };
    try {
      const renderer = await renderScreen();
      expect(renderer.root.findByType('WorkspaceSettings').props.workspaceId).toBe('workspace-1');
    } finally {
      routeParams.value = {};
    }
  });

  it('shows a member no workspace settings at all, even from an old Workspace settings link', async () => {
    respond('member');
    routeParams.value = { tab: 'workspace', workspaceId: 'workspace-1' };
    try {
      const renderer = await renderScreen();
      const { SettingsScopeTabs } = await import('@/components/buzz/SettingsScopeTabs');
      const { ProfileIdentity } = await import('@/components/buzz/ProfileIdentity');
      expect(renderer.root.findAllByType(SettingsScopeTabs)).toHaveLength(0);
      expect(renderer.root.findAll((node) => node.props.accessibilityRole === 'tab')).toHaveLength(0);
      expect(renderer.root.findAllByProps({ testID: 'settings-workspace-tab' })).toHaveLength(0);
      expect(renderer.root.findAllByProps({ testID: 'settings-workspace-row' })).toHaveLength(0);
      expect(renderer.root.findAllByType('WorkspaceSettings')).toHaveLength(0);
      expect(renderer.root.findAllByType(ProfileIdentity)).toHaveLength(1);
      expect(headings(renderer)).toEqual(expect.arrayContaining(['CONNECTORS', 'DEVICE', 'ACCOUNT']));
    } finally {
      routeParams.value = {};
    }
  });
});
