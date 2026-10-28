vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@expo/vector-icons', async () => { const R = await import('react'); return { Ionicons: (props: any) => R.createElement('Ionicons', props) }; });
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'Light' }, impactAsync: async () => undefined }));
vi.mock('react-native-keyboard-controller', async () => { const R = await import('react'); return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) }; });
import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const storage = vi.hoisted(() => new Map<string, string>());
const linking = vi.hoisted(() => ({
  initialUrl: null as string | null,
  listener: null as ((event: { url: string }) => void) | null,
}));
const browser = vi.hoisted(() => ({ open: vi.fn() }));
// The device's network: every auth-server request the sign-in makes goes through it.
const network = vi.hoisted(() => ({ online: true, fetch: vi.fn() }));
const runtime = vi.hoisted(() => ({
  current: {
    relayUrl: 'https://relay.test',
    pushGatewayUrl: 'https://relay.test/push',
    monolithUrl: 'https://server.usebeeline.app',
  },
}));
const MONOLITH_IDENTITY = 'm'.repeat(64);
const monolith = vi.hoisted(() => ({
  exchangeGitHubTicket: vi.fn(async () => 'm'.repeat(64)),
  reconnectGitHubTicket: vi.fn(async () => undefined),
  identityId: vi.fn(async () => 'm'.repeat(64)),
}));
const phoneOperation = vi.hoisted(() => vi.fn(async (_name: string, _input: unknown) => ({})));
const identityStorage = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(async () => undefined),
  generate: vi.fn(async () => ({ secretKey: '1'.repeat(64), publicKey: '2'.repeat(64) })),
  pending: null as { secretKey: string; publicKey: string } | null,
  loadPending: vi.fn(async () => identityStorage.pending),
  savePending: vi.fn(async (identity: { secretKey: string; publicKey: string }) => {
    identityStorage.pending = identity;
  }),
  clearPending: vi.fn(async () => {
    identityStorage.pending = null;
  }),
}));
const sdk = vi.hoisted(() => ({
  finish: vi.fn(async () => ({ linked: true })),
  recover: vi.fn(async () => ({ linked: true, replaced: true })),
  getCapabilities: vi.fn(async () => ({ github: true, oidc: true })),
  startInstallation: vi.fn(async () => 'https://github.test/apps/beeline/installations/new'),
  listRepositories: vi.fn(async () => ({ installed: true, installations: [], repositories: [] })),
  lookupRecovery: vi.fn(async () => [] as { provider: string; subject: string; pubkey: string }[]),
  lookupManagedIdentity: vi.fn(async () => null),
}));
const profileClient = vi.hoisted(() => ({
  getGlobalPersonProfile: vi.fn(async () => null),
  setGlobalPersonProfile: vi.fn(async (profile: unknown) => profile),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void storage.set(key, value)),
    removeItem: vi.fn(async (key: string) => void storage.delete(key)),
  },
}));
vi.mock('@beeline/buzz-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@beeline/buzz-client')>();
  return {
    ...actual,
    buildOidcBindEvent: vi.fn((_challenge, identity) => ({
      id: 'bind-event',
      pubkey: identity.publicKey,
    })),
    finishOidcBind: sdk.finish,
    recoverOidcBind: sdk.recover,
    getAuthCapabilities: sdk.getCapabilities,
    listGitHubRepositories: sdk.listRepositories,
    lookupRecovery: sdk.lookupRecovery,
    lookupManagedIdentity: sdk.lookupManagedIdentity,
    startGitHubInstallation: sdk.startInstallation,
  };
});
vi.mock('expo-router', () => ({ router: navigation }));
vi.mock('expo-linking', () => ({
  createURL: (path: string) => `beeline://${path}`,
  getInitialURL: vi.fn(async () => linking.initialUrl),
  addEventListener: vi.fn((_name: string, listener: (event: { url: string }) => void) => {
    linking.listener = listener;
    return { remove: () => (linking.listener = null) };
  }),
}));
vi.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: vi.fn(),
  openAuthSessionAsync: browser.open,
}));
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  clearPendingGitHubIdentity: identityStorage.clearPending,
  loadBuzzIdentity: identityStorage.load,
  loadPendingGitHubIdentity: identityStorage.loadPending,
}));
vi.mock('@/buzz/person-name', () => ({
  clearPersonNameOnboardingPending: vi.fn(async () => undefined),
  loadPreferredPersonName: vi.fn(async () => 'Ada'),
  markPersonNameOnboardingPending: vi.fn(async () => undefined),
  resolveOnboardingPersonName: vi.fn(async () => ({
    needsPrompt: false,
    name: 'Ada',
    communityId: 'workspace-1',
  })),
  savePreferredPersonName: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => runtime.current,
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: monolith,
  GitHubAccountMismatchError: class extends Error {},
}));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));
vi.mock('@/push/buzz-push-registration', () => ({
  registerBuzzPushNotifications: vi.fn(async () => undefined),
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => profileClient);
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (factory: any) => factory({ buzz: { type: { sectionHead: {}, sectionLabel: { fontSize: 13, lineHeight: 19, letterSpacing: 2 }, sectionCount: { fontSize: 15, lineHeight: 22 } }, space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 }, roomList: { edge: 20 } }, colors: {} }) },
  useUnistyles: () => ({ theme: { buzz: { textDisabled: '#777' } } }),
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { StyleSheet: { flatten: (style: any): any => Array.isArray(style) ? Object.assign({}, ...style.map((part: any) => Array.isArray(part) ? Object.assign({}, ...part) : part)) : style },
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.android },
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('@/components/buzz/BeelineMark', async () => {
  const ReactModule = await import('react');
  return { BeelineMark: (props: any) => ReactModule.createElement('BeelineMark', props) };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    HullSurface: host('HullSurface'),
    PixelGateReveal: host('PixelGateReveal'),
  };
});
vi.mock('@/components/buzz/Button', async () => {
  const ReactModule = await import('react');
  return { Button: (props: any) => ReactModule.createElement('Button', props, props.children) };
});
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), logo: () => ({}), mono: () => ({}) },
}));

const { persistGitHubSignInState } = await import('@/auth/github-auth-session');
const { OidcBindError } = await import('@beeline/buzz-client');
const { clearOnboardingNotice, markSignInInFlight, publishOnboardingNotice, noticeForAuthError } =
  await import('@/auth/onboarding-state');
const { default: BuzzOnboarding } = await import('./onboarding');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const STATE = 's'.repeat(43);
const RECOVERY_TOKEN = 'r'.repeat(43);

function callbackUrl(state = STATE, issuedAt = Math.floor(Date.now() / 1_000)): string {
  const params = new URLSearchParams({
    state,
    protocol: '1',
    kind: '24250',
    marker: 'beeline-oidc-bind-v1',
    ticket: 't'.repeat(43),
    challenge: 'c'.repeat(43),
    provider: 'https://github.com',
    audience: 'beeline-mobile',
    subject: '269599412',
    community: 'relay.buzzrouter.com',
    issued_at: String(issuedAt),
    expires_at: String(issuedAt + 120),
  });
  return `beeline://beeline/github-callback?${params}`;
}

/** Let every queued microtask and timer-free continuation run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

async function render(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(BuzzOnboarding));
  });
  return tree;
}

function noticeText(tree: ReactTestRenderer): string {
  return tree.root
    .findAllByType('Text' as any)
    .map((node) => String(node.props.children))
    .join(' ');
}

describe('GitHub callback delivery into onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.clear();
    clearOnboardingNotice();
    markSignInInFlight(false);
    network.online = true;
    network.fetch.mockImplementation(async () => {
      if (!network.online) throw new TypeError('Network request failed');
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', network.fetch);
    linking.initialUrl = null;
    linking.listener = null;
    monolith.exchangeGitHubTicket.mockResolvedValue(MONOLITH_IDENTITY);
    monolith.identityId.mockResolvedValue(null);
    phoneOperation.mockImplementation(async () => ({}));
    identityStorage.pending = null;
    identityStorage.load.mockResolvedValue(null);
    identityStorage.save.mockResolvedValue(undefined);
    identityStorage.generate.mockResolvedValue({
      secretKey: '1'.repeat(64),
      publicKey: '2'.repeat(64),
    });
    sdk.finish.mockResolvedValue({ linked: true });
    sdk.recover.mockResolvedValue({ linked: true, replaced: true });
    sdk.getCapabilities.mockResolvedValue({ github: true, oidc: true });
    sdk.listRepositories.mockResolvedValue({
      installed: true,
      installations: [],
      repositories: [],
    });
    sdk.lookupRecovery.mockResolvedValue([]);
    sdk.lookupManagedIdentity.mockResolvedValue(null);
    profileClient.getGlobalPersonProfile.mockResolvedValue(null);
    profileClient.setGlobalPersonProfile.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the primary GitHub button before sign-in', async () => {
    const tree = await render();
    const button = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'onboarding-github-sign-in');
    expect(button.props.variant).toBe('primary');
    expect(tree.root.findAll((node: any) => node.type === 'Button').map((node: any) => node.props.label))
      .toEqual(['Continue with GitHub', 'Continue with Google']);
  });

  it('R-signin-entry: enters after exchange even when GitHub repository discovery is unavailable', async () => {
    await persistGitHubSignInState(STATE);
    linking.initialUrl = callbackUrl();
    phoneOperation.mockImplementation(async (name: string) => {
      if (name === 'getAuthCapabilities') return { repositoryOnboarding: true };
      if (name === 'listGitHubRepositories') throw new Error('GitHub unavailable');
      return {};
    });
    await render();
    expect(monolith.exchangeGitHubTicket).toHaveBeenCalledOnce();
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/channels');
  });

  it('R-signin-entry: restores a saved session before touching a consumed Google continuation', async () => {
    monolith.identityId.mockResolvedValue(MONOLITH_IDENTITY);
    storage.set('beeline.google-sign-in.v1', JSON.stringify({
      state: STATE, recoveryToken: RECOVERY_TOKEN, startedAt: Date.now(),
    }));
    network.fetch.mockImplementation(async () => new Response('{}', { status: 410 }));
    const tree = await render();
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/channels');
    expect(noticeText(tree)).not.toContain('Sign-in expired');
    expect(network.fetch).not.toHaveBeenCalled();
  });

  it.each(['browser_canceled', 'ticket_expired', 'offline'])(
    'shows one primary recovery action for %s on the full screen', async (code) => {
      const tree = await render();
      await act(async () => { publishOnboardingNotice(noticeForAuthError(new OidcBindError(code, code))); });
      const buttons = tree.root.findAll((node: any) => node.type === 'Button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0].props.variant).toBe('primary');
      expect(buttons[0].props.label).toBe(code === 'offline' ? 'Try again' : 'Continue with GitHub');
    },
  );

  it('opens monolith sign-in on server.usebeeline.app and exchanges its callback there', async () => {
    phoneOperation.mockImplementation(async (name: string) =>
      name === 'getManagedIdentity'
        ? { personId: MONOLITH_IDENTITY, name: 'Octo Cat', handle: 'octocat' }
        : {},
    );
    browser.open.mockImplementation(async (authorizationUrl: string) => {
      const authorization = new URL(authorizationUrl);
      expect(authorization.origin).toBe('https://server.usebeeline.app');
      expect(authorization.pathname).toBe('/auth/github/start');
      const state = authorization.searchParams.get('app_state')!;
      queueMicrotask(() => linking.listener?.({ url: callbackUrl(state) }));
      return { type: 'dismiss' };
    });
    const tree = await render();
    const signIn = tree.root.find(
      (node: any) => node.type === 'Button' && node.props.label === 'Continue with GitHub',
    );

    await act(async () => {
      await signIn.props.onPress();
    });

    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(monolith.exchangeGitHubTicket).toHaveBeenCalledWith('t'.repeat(43));
    expect(sdk.finish).not.toHaveBeenCalled();

    expect(phoneOperation).not.toHaveBeenCalledWith('updateIdentityFace', expect.anything());
    expect(phoneOperation).not.toHaveBeenCalledWith('claimManagedHandle', expect.anything());
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/channels');
  });

  // A warm callback routes another screen while the original press owns the
  // exchange. That press must finish once and enter the app without a second tap.
  it('finishes the first press on the onboarding screen its own callback routed in', async () => {
    let releaseBrowser!: () => void;
    let releaseExchange!: (identityId: string) => void;
    browser.open.mockImplementation(async (authorizationUrl: string) => {
      const state = new URL(authorizationUrl).searchParams.get('app_state')!;
      await new Promise<void>((resolve) => {
        releaseBrowser = () => {
          linking.listener?.({ url: callbackUrl(state) });
          resolve();
        };
      });
      return { type: 'dismiss' };
    });
    monolith.exchangeGitHubTicket.mockImplementation(
      () => new Promise<string>((resolve) => (releaseExchange = resolve)),
    );

    const pressed = await render();
    const signIn = pressed.root.find(
      (node: any) => node.type === 'Button' && node.props.label === 'Continue with GitHub',
    );
    let press!: Promise<void>;
    await act(async () => {
      press = signIn.props.onPress();
      await settle();
    });
    expect(browser.open).toHaveBeenCalledTimes(1);

    // The browser hands the callback back, and the exchange is in flight.
    await act(async () => {
      releaseBrowser();
      await settle();
    });

    // expo-router routes that callback: a second onboarding screen, on top.
    const routed = await render();
    expect(monolith.exchangeGitHubTicket).toHaveBeenCalledTimes(1);
    expect(
      routed.root.findAll(
        (node: any) => node.type === 'Button' && node.props.label === 'Continue with GitHub',
      ),
    ).toHaveLength(1);

    await act(async () => {
      releaseExchange(MONOLITH_IDENTITY);
      await press;
      await settle();
    });

    expect(monolith.exchangeGitHubTicket).toHaveBeenCalledTimes(1);
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/channels');
  });

  it('finishes a cold completed callback after the server initially reports pending', async () => {
    await persistGitHubSignInState(STATE, 'signin', RECOVERY_TOKEN);
    linking.initialUrl = `beeline://beeline/github-callback?state=${STATE}&completed=1`;
    let completionReads = 0;
    network.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      if (!String(input).endsWith('/auth/github/completion')) {
        throw new Error(`Unexpected auth request: ${String(input)}`);
      }
      completionReads += 1;
      if (completionReads <= 2) return new Response(null, { status: 202 });
      const challenge = Object.fromEntries(new URL(callbackUrl()).searchParams);
      return new Response(JSON.stringify({ ...challenge, ticket: RECOVERY_TOKEN }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const tree = await render();

    await act(async () => {
      await vi.waitFor(() =>
        expect(monolith.exchangeGitHubTicket).toHaveBeenCalledWith(RECOVERY_TOKEN),
      );
    });
    expect(completionReads).toBe(3);
    expect(browser.open).not.toHaveBeenCalled();
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/channels');
  });

  it('skips the face ceremony for a person who already chose a face', async () => {
    phoneOperation.mockImplementation(async (name: string) =>
      name === 'getManagedIdentity'
        ? { personId: MONOLITH_IDENTITY, name: 'Ada', face: 'cat' }
        : {},
    );
    browser.open.mockImplementation(async (authorizationUrl: string) => {
      const state = new URL(authorizationUrl).searchParams.get('app_state')!;
      queueMicrotask(() => linking.listener?.({ url: callbackUrl(state) }));
      return { type: 'dismiss' };
    });
    const tree = await render();
    const signIn = tree.root.find(
      (node: any) => node.type === 'Button' && node.props.label === 'Continue with GitHub',
    );
    await act(async () => {
      await signIn.props.onPress();
    });
    expect(phoneOperation).not.toHaveBeenCalledWith('updateIdentityFace', expect.anything());
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/channels');
  });

  it('shows no connection with one Try again, and retries nothing until it is pressed', async () => {
    network.online = false;
    browser.open.mockImplementation(async (authorizationUrl: string) => {
      const state = new URL(authorizationUrl).searchParams.get('app_state')!;
      queueMicrotask(() => linking.listener?.({ url: callbackUrl(state) }));
      return { type: 'dismiss' };
    });
    vi.useFakeTimers();
    try {
      const tree = await render();
      const signIn = () =>
        tree.root.find(
          (node: any) =>
            node.type === 'Button' && node.props.testID === 'onboarding-github-sign-in',
        );
      expect(signIn().props.label).toBe('Continue with GitHub');
      expect(signIn().props.variant).toBe('primary');

      await act(async () => {
        await signIn().props.onPress();
      });

      // Offline, no browser opens: it could only show its own error page.
      expect(browser.open).not.toHaveBeenCalled();
      expect(noticeText(tree)).toContain('No connection');
      expect(noticeText(tree)).toContain("You're offline.");
      expect(signIn().props.label).toBe('Try again');
      expect(tree.root.findAll((node: any) => node.type === 'Button')).toHaveLength(1);
      expect(signIn().props.variant).toBe('primary');
      expect(signIn().props.loading).toBe(false);
      expect(signIn().props.disabled).toBe(false);

      // Nothing retries behind the person's back: minutes pass, the screen holds.
      const requestsAfterPress = network.fetch.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(network.fetch).toHaveBeenCalledTimes(requestsAfterPress);
      expect(browser.open).not.toHaveBeenCalled();
      expect(tree.root.findAll((node: any) => node.type === 'Button')).toHaveLength(1);
      expect(signIn().props.label).toBe('Try again');
      expect(signIn().props.loading).toBe(false);

      // The network returns; only the press signs in.
      network.online = true;
      await act(async () => {
        await signIn().props.onPress();
      });
      expect(browser.open).toHaveBeenCalledTimes(1);
      expect(monolith.exchangeGitHubTicket).toHaveBeenCalledWith('t'.repeat(43));
      expect(navigation.replace).toHaveBeenCalledWith('/beeline/channels');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a genuine GitHub refusal on its own message, not the no-connection state', async () => {
    browser.open.mockImplementation(async (authorizationUrl: string) => {
      const state = new URL(authorizationUrl).searchParams.get('app_state')!;
      queueMicrotask(() =>
        linking.listener?.({
          url: `beeline://beeline/github-callback?state=${state}&error=github_denied`,
        }),
      );
      return { type: 'dismiss' };
    });
    const tree = await render();
    const signIn = tree.root.find(
      (node: any) =>
        node.type === 'Button' && node.props.testID === 'onboarding-github-sign-in',
    );

    await act(async () => {
      await signIn.props.onPress();
    });

    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(noticeText(tree)).not.toContain('No connection');
    expect(noticeText(tree)).toContain('Sign-in did not finish');
    expect(
      tree.root.find(
        (node: any) =>
          node.type === 'Button' && node.props.testID === 'onboarding-github-sign-in',
      ).props.label,
    ).toBe('Continue with GitHub');
  });

  it('renders GitHub on the first frame without waiting for auth capabilities', () => {
    sdk.getCapabilities.mockImplementation(
      () => new Promise<{ github: boolean; oidc: boolean }>(() => undefined),
    );
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(React.createElement(BuzzOnboarding));
    });

    expect(
      tree.root.findAll(
        (node: any) => node.type === 'Button' && node.props.label === 'Continue with GitHub',
      ),
    ).toHaveLength(1);
    expect(sdk.getCapabilities).not.toHaveBeenCalled();
    expect(noticeText(tree)).not.toContain(['Goo', 'gle'].join(''));
    act(() => tree.unmount());
  });

  it('never consults capabilities or falls back to the legacy provider when the network fails', async () => {
    sdk.getCapabilities.mockRejectedValue(new Error('offline'));
    const tree = await render();
    const signIn = tree.root.find(
      (node: any) => node.type === 'Button' && node.props.label === 'Continue with GitHub',
    );

    await act(async () => {
      await signIn.props.onPress();
    });

    expect(sdk.getCapabilities).not.toHaveBeenCalled();
    expect(noticeText(tree)).not.toContain(['Goo', 'gle'].join(''));
  });

  it.each([false, true])(
    'cold reconnect preserves the session and returns to Settings (failure=%s)',
    async (fails) => {
      await persistGitHubSignInState(STATE, 'reconnect');
      linking.initialUrl = callbackUrl();
      if (fails) monolith.reconnectGitHubTicket.mockRejectedValueOnce(new Error('offline'));
      await render();
      expect(monolith.reconnectGitHubTicket).toHaveBeenCalledWith('t'.repeat(43));
      expect(monolith.exchangeGitHubTicket).not.toHaveBeenCalled();
      expect(sdk.finish).not.toHaveBeenCalled();
      expect(sdk.recover).not.toHaveBeenCalled();
      expect(navigation.replace).toHaveBeenCalledWith({
        pathname: '/beeline/settings',
        params: { githubReconnect: fails ? 'failed' : 'success' },
      });
    },
  );

  it('returns a signed-in device to Rooms when OTA replays a completed, now-expired GitHub launch callback', async () => {
    monolith.identityId.mockResolvedValue(MONOLITH_IDENTITY);
    linking.initialUrl = callbackUrl(STATE, Math.floor(Date.now() / 1_000) - 3_600);
    const renderer = await render();
    expect(monolith.exchangeGitHubTicket).not.toHaveBeenCalled();
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/channels');
    expect(noticeText(renderer)).not.toContain('SESSION_EXPIRED');
  });

  it('rejects a cold state mismatch without binding or saving a key', async () => {
    await persistGitHubSignInState(STATE);
    linking.initialUrl = callbackUrl('x'.repeat(43));

    const tree = await render();

    expect(sdk.finish).not.toHaveBeenCalled();
    expect(identityStorage.save).not.toHaveBeenCalled();
    expect(noticeText(tree)).toContain('Sign-in did not finish');
  });

  it('shows SESSION EXPIRED and leaves the sign-in action available', async () => {
    const now = Math.floor(Date.now() / 1_000);
    await persistGitHubSignInState(STATE);
    linking.initialUrl = callbackUrl(STATE, now - 121);

    const tree = await render();

    expect(sdk.finish).not.toHaveBeenCalled();
    expect(noticeText(tree)).toContain('Sign-in expired');
    expect(tree.root.findAll((node: any) => node.type === 'Button')).toHaveLength(1);
    expect(tree.root.findByType('Button' as never).props.variant).toBe('primary');
    expect(
      tree.root.findAll(
        (node: any) => node.type === 'Button' && node.props.label === 'Continue with GitHub',
      ),
    ).toHaveLength(1);
  });

});
