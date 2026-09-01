import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const storage = vi.hoisted(() => new Map<string, string>());
const linking = vi.hoisted(() => ({
  initialUrl: null as string | null,
  listener: null as ((event: { url: string }) => void) | null,
}));
const browser = vi.hoisted(() => ({ open: vi.fn() }));
const runtime = vi.hoisted(() => ({
  current: {
    relayUrl: 'https://relay.test',
    pushGatewayUrl: 'https://relay.test/push',
    monolithUrl: 'https://server.usebeeline.app',
    monolithEnabled: false,
  },
}));
const monolith = vi.hoisted(() => ({ exchangeGitHubTicket: vi.fn(async () => undefined) }));
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
  lookupRecovery: vi.fn(
    async () => [] as { provider: string; subject: string; pubkey: string }[],
  ),
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
  generateBuzzIdentity: identityStorage.generate,
  importBuzzIdentity: vi.fn(),
  loadBuzzIdentity: identityStorage.load,
  loadPendingGitHubIdentity: identityStorage.loadPending,
  savePendingGitHubIdentity: identityStorage.savePending,
  saveBuzzIdentity: identityStorage.save,
}));
vi.mock('@/buzz/person-name', () => ({
  clearPersonNameOnboardingPending: vi.fn(async () => undefined),
  isPersonNameOnboardingPending: vi.fn(async () => false),
  loadPreferredPersonName: vi.fn(async () => 'Ada'),
  markPersonNameOnboardingPending: vi.fn(async () => undefined),
  publishPreferredPersonName: vi.fn(),
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
vi.mock('@/auth/monolith-session', () => ({ monolithSession: monolith }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
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
  StyleSheet: { create: (factory: any) => factory({ buzz: {}, colors: {} }) },
  useUnistyles: () => ({ theme: { buzz: { textDisabled: '#777' } } }),
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
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
    MonoButton: host('MonoButton'),
    PixelGateReveal: host('PixelGateReveal'),
  };
});
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), logo: () => ({}), mono: () => ({}) },
}));

const { persistGitHubSignInState } = await import('@/auth/github-auth-session');
const { OidcBindError } = await import('@beeline/buzz-client');
const { clearOnboardingNotice } = await import('@/auth/onboarding-state');
const { default: BuzzOnboarding } = await import('./onboarding');

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const STATE = 's'.repeat(43);

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
  return `beeline://buzz/github-callback?${params}`;
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
    linking.initialUrl = null;
    linking.listener = null;
    runtime.current.monolithEnabled = false;
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
    sdk.listRepositories.mockResolvedValue({ installed: true, installations: [], repositories: [] });
    sdk.lookupRecovery.mockResolvedValue([]);
    sdk.lookupManagedIdentity.mockResolvedValue(null);
    profileClient.getGlobalPersonProfile.mockResolvedValue(null);
    profileClient.setGlobalPersonProfile.mockClear();
  });

  it('opens monolith sign-in on server.usebeeline.app and exchanges its callback there', async () => {
    runtime.current.monolithEnabled = true;
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
      (node: any) => node.type === 'MonoButton' && node.props.label === 'Continue with GitHub',
    );

    await act(async () => {
      await signIn.props.onPress();
    });

    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(monolith.exchangeGitHubTicket).toHaveBeenCalledWith('t'.repeat(43));
    expect(sdk.finish).not.toHaveBeenCalled();
    expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels');
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
        (node: any) => node.type === 'MonoButton' && node.props.label === 'Continue with GitHub',
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
      (node: any) => node.type === 'MonoButton' && node.props.label === 'Continue with GitHub',
    );

    await act(async () => {
      await signIn.props.onPress();
    });

    expect(sdk.getCapabilities).not.toHaveBeenCalled();
    expect(noticeText(tree)).not.toContain(['Goo', 'gle'].join(''));
  });

  it('keeps an existing device usable when its stored key has only a legacy recovery link', async () => {
    const identity = { secretKey: '1'.repeat(64), publicKey: '2'.repeat(64) };
    identityStorage.load.mockResolvedValue(identity);
    sdk.lookupRecovery.mockResolvedValue([
      {
        provider: 'https://accounts.example',
        subject: 'existing-account',
        pubkey: identity.publicKey,
      },
    ]);

    await render();

    expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels');
    expect(sdk.listRepositories).not.toHaveBeenCalled();
    expect(browser.open).not.toHaveBeenCalled();
  });

  it('enters with an existing GitHub-linked identity without requiring App installation', async () => {
    const identity = { secretKey: '1'.repeat(64), publicKey: '2'.repeat(64) };
    identityStorage.load.mockResolvedValue(identity);
    sdk.lookupRecovery.mockResolvedValue([
      {
        provider: 'https://github.com',
        subject: '269599412',
        pubkey: identity.publicKey,
      },
    ]);
    sdk.listRepositories.mockResolvedValue({
      installed: false,
      installations: [],
      repositories: [],
    });

    await render();

    expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels');
    expect(sdk.listRepositories).not.toHaveBeenCalled();
    expect(browser.open).not.toHaveBeenCalled();
  });

  it('promotes a pending key when lookup proves the server already completed the bind', async () => {
    const identity = { secretKey: '1'.repeat(64), publicKey: '2'.repeat(64) };
    identityStorage.pending = identity;
    sdk.lookupRecovery.mockResolvedValue([
      {
        provider: 'https://github.com',
        subject: '269599412',
        pubkey: identity.publicKey,
      },
    ]);
    sdk.lookupManagedIdentity.mockResolvedValue({
      handle: 'octocat',
      nip05: 'octocat@usebeeline.app',
      displayName: 'The Octocat',
      source: 'github',
      githubRenameAvailable: false,
    });

    const tree = await render();

    expect(sdk.lookupManagedIdentity).toHaveBeenCalledWith('https://relay.test', identity);
    await vi.waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels'),
    );
    expect(identityStorage.save).toHaveBeenCalledWith(identity);
    expect(identityStorage.clearPending).toHaveBeenCalledTimes(1);
    expect(browser.open).not.toHaveBeenCalled();
    expect(sdk.finish).not.toHaveBeenCalled();
    expect(noticeText(tree)).not.toContain('IDENTITY_CONFLICT');
  });

  it('cold-starts, binds the proof, saves the identity, and enters the workspace', async () => {
    await persistGitHubSignInState(STATE);
    linking.initialUrl = callbackUrl();

    await render();

    expect(sdk.finish).toHaveBeenCalledTimes(1);
    expect(identityStorage.save).toHaveBeenCalledTimes(1);
    expect(sdk.listRepositories).not.toHaveBeenCalled();
    expect(sdk.startInstallation).not.toHaveBeenCalled();
    expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels');
  });

  it('lands a GitHub login with its auto-provisioned handle and NIP-05 without asking', async () => {
    sdk.finish.mockResolvedValueOnce({
      linked: true,
      idempotent: false,
      pubkey: '2'.repeat(64),
      identity: {
        handle: 'octocat',
        displayName: 'The Octocat',
        nip05: 'octocat@usebeeline.app',
        source: 'github',
        githubLogin: 'octocat',
        githubRenameAvailable: false,
      },
    });
    await persistGitHubSignInState(STATE);
    linking.initialUrl = callbackUrl();

    const tree = await render();

    expect(profileClient.setGlobalPersonProfile).toHaveBeenCalledWith({
      name: 'The Octocat',
      handle: 'octocat',
      avatar: undefined,
      nip05: 'octocat@usebeeline.app',
    });
    expect(
      tree.root.findAll((node: any) => node.props?.testID === 'onboarding-handle-ceremony'),
    ).toHaveLength(0);
    expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels');
  });

  it('rejects a cold state mismatch without binding or saving a key', async () => {
    await persistGitHubSignInState(STATE);
    linking.initialUrl = callbackUrl('x'.repeat(43));

    const tree = await render();

    expect(sdk.finish).not.toHaveBeenCalled();
    expect(identityStorage.save).not.toHaveBeenCalled();
    expect(noticeText(tree)).toContain('SIGN-IN REJECTED · STATE_MISMATCH');
  });

  it('shows SESSION EXPIRED and leaves the sign-in action available', async () => {
    const now = Math.floor(Date.now() / 1_000);
    await persistGitHubSignInState(STATE);
    linking.initialUrl = callbackUrl(STATE, now - 121);

    const tree = await render();

    expect(sdk.finish).not.toHaveBeenCalled();
    expect(noticeText(tree)).toContain('SESSION EXPIRED · TICKET_EXPIRED');
    expect(
      tree.root.findAll(
        (node: any) => node.type === 'MonoButton' && node.props.label === 'Continue with GitHub',
      ),
    ).toHaveLength(1);
  });

  it('binds and enters the workspace when a warm Linking event wins the browser race', async () => {
    browser.open.mockImplementation(async (authorizationUrl: string) => {
      const state = new URL(authorizationUrl).searchParams.get('app_state')!;
      queueMicrotask(() => linking.listener?.({ url: callbackUrl(state) }));
      return { type: 'dismiss' };
    });
    const tree = await render();
    const signIn = tree.root.find(
      (node: any) => node.type === 'MonoButton' && node.props.label === 'Continue with GitHub',
    );

    await act(async () => {
      await signIn.props.onPress();
    });

    expect(sdk.finish).toHaveBeenCalledTimes(1);
    expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels');
  });

  it('reuses the durable pending key when the callback remounts onboarding before a 201 is saved', async () => {
    const firstIdentity = { secretKey: '1'.repeat(64), publicKey: '2'.repeat(64) };
    const accidentalSecondIdentity = { secretKey: '3'.repeat(64), publicKey: '4'.repeat(64) };
    identityStorage.generate
      .mockResolvedValueOnce(firstIdentity)
      .mockResolvedValueOnce(accidentalSecondIdentity);
    let releaseFirstSave!: () => void;
    identityStorage.save
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstSave = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    browser.open.mockImplementation(async (authorizationUrl: string) => {
      const state = new URL(authorizationUrl).searchParams.get('app_state')!;
      queueMicrotask(() => linking.listener?.({ url: callbackUrl(state) }));
      return { type: 'dismiss' };
    });

    const firstTree = await render();
    const firstSignIn = firstTree.root.find(
      (node: any) => node.type === 'MonoButton' && node.props.label === 'Continue with GitHub',
    );
    let firstAttempt!: Promise<void>;
    act(() => {
      firstAttempt = firstSignIn.props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sdk.finish).toHaveBeenCalledTimes(1);
    expect(identityStorage.save).toHaveBeenCalledTimes(1);

    await act(async () => firstTree.unmount());
    const remountedTree = await render();
    const retry = remountedTree.root.find(
      (node: any) => node.type === 'MonoButton' && node.props.label === 'Continue with GitHub',
    );
    await act(async () => {
      await retry.props.onPress();
    });

    expect(sdk.finish).toHaveBeenCalledTimes(2);
    expect(sdk.finish.mock.calls[1]?.[2]).toMatchObject({ pubkey: firstIdentity.publicKey });
    expect(noticeText(remountedTree)).not.toContain('IDENTITY_CONFLICT');
    expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels');

    releaseFirstSave();
    await act(async () => firstAttempt);
  });

  it('offers an explicit device-key replacement after OAuth proves the linked GitHub account', async () => {
    sdk.finish.mockRejectedValueOnce(
      new OidcBindError('identity_conflict', 'identity is already bound to another public key', 409),
    );
    browser.open.mockImplementation(async (authorizationUrl: string) => {
      const state = new URL(authorizationUrl).searchParams.get('app_state')!;
      queueMicrotask(() => linking.listener?.({ url: callbackUrl(state) }));
      return { type: 'dismiss' };
    });
    const tree = await render();
    const signIn = tree.root.find(
      (node: any) => node.type === 'MonoButton' && node.props.label === 'Continue with GitHub',
    );

    await act(async () => {
      await signIn.props.onPress();
    });

    expect(noticeText(tree)).toContain('DEVICE KEY ALREADY LINKED · IDENTITY_CONFLICT');
    const replace = tree.root.find(
      (node: any) => node.type === 'MonoButton' && node.props.label === 'Replace device key',
    );
    await act(async () => {
      await replace.props.onPress();
    });

    expect(sdk.recover).toHaveBeenCalledTimes(1);
    expect(identityStorage.save).toHaveBeenCalledTimes(1);
    expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels');
    expect(noticeText(tree)).not.toContain('IDENTITY_CONFLICT');
  });

  it('keeps the replacement action available when the conflict callback remounts onboarding', async () => {
    const conflict = new OidcBindError(
      'identity_conflict',
      'identity is already bound to another public key',
      409,
    );
    let rejectOriginalBind!: (error: unknown) => void;
    sdk.finish
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOriginalBind = reject;
          }),
      )
      .mockRejectedValueOnce(conflict);
    browser.open.mockImplementation(async (authorizationUrl: string) => {
      const state = new URL(authorizationUrl).searchParams.get('app_state')!;
      queueMicrotask(() => linking.listener?.({ url: callbackUrl(state) }));
      return { type: 'dismiss' };
    });

    const originalTree = await render();
    const signIn = originalTree.root.find(
      (node: any) => node.type === 'MonoButton' && node.props.label === 'Continue with GitHub',
    );
    act(() => {
      void signIn.props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sdk.finish).toHaveBeenCalledTimes(1);

    await act(async () => originalTree.unmount());
    const remountedTree = await render();
    await act(async () => {
      rejectOriginalBind(conflict);
      await Promise.resolve();
      await Promise.resolve();
    });

    const replace = remountedTree.root.find(
      (node: any) => node.type === 'MonoButton' && node.props.label === 'Replace device key',
    );
    await act(async () => {
      await replace.props.onPress();
    });

    expect(sdk.recover).toHaveBeenCalledTimes(1);
    expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels');
    expect(noticeText(remountedTree)).not.toContain('IDENTITY_CONFLICT');
  });

  it('opens exactly one browser during sign-in when GitHub repository access is not installed', async () => {
    sdk.listRepositories.mockResolvedValue({
      installed: false,
      installations: [],
      repositories: [],
    });
    browser.open.mockImplementation(async (authorizationUrl: string) => {
      if (browser.open.mock.calls.length === 1) {
        const state = new URL(authorizationUrl).searchParams.get('app_state')!;
        queueMicrotask(() => linking.listener?.({ url: callbackUrl(state) }));
      }
      return { type: 'dismiss' };
    });
    const tree = await render();
    const signIn = tree.root.find(
      (node: any) => node.type === 'MonoButton' && node.props.label === 'Continue with GitHub',
    );

    await act(async () => {
      await signIn.props.onPress();
    });

    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(sdk.finish).toHaveBeenCalledTimes(1);
    expect(identityStorage.save).toHaveBeenCalledTimes(1);
    expect(sdk.listRepositories).not.toHaveBeenCalled();
    expect(sdk.startInstallation).not.toHaveBeenCalled();
    expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels');
  });

  it('keeps a completed bind signed in when deferred GitHub installation would fail', async () => {
    sdk.listRepositories.mockResolvedValue({
      installed: false,
      installations: [],
      repositories: [],
    });
    sdk.startInstallation.mockRejectedValue(
      new OidcBindError('browser_canceled', 'The installation browser was canceled'),
    );
    browser.open.mockImplementation(async (authorizationUrl: string) => {
      const state = new URL(authorizationUrl).searchParams.get('app_state')!;
      queueMicrotask(() => linking.listener?.({ url: callbackUrl(state) }));
      return { type: 'dismiss' };
    });
    const tree = await render();
    const signIn = tree.root.find(
      (node: any) => node.type === 'MonoButton' && node.props.label === 'Continue with GitHub',
    );

    await act(async () => {
      await signIn.props.onPress();
    });

    expect(sdk.finish).toHaveBeenCalledTimes(1);
    expect(identityStorage.save).toHaveBeenCalledTimes(1);
    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(sdk.listRepositories).not.toHaveBeenCalled();
    expect(sdk.startInstallation).not.toHaveBeenCalled();
    expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels');
    expect(noticeText(tree)).not.toContain('SIGN-IN CANCELED');
  });

  it('renders the bind failure notice after a warm deep link remounts onboarding', async () => {
    let rejectBind!: (error: unknown) => void;
    sdk.finish.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectBind = reject;
        }),
    );
    browser.open.mockImplementation(async (authorizationUrl: string) => {
      const state = new URL(authorizationUrl).searchParams.get('app_state')!;
      queueMicrotask(() => linking.listener?.({ url: callbackUrl(state) }));
      return { type: 'dismiss' };
    });

    const originalTree = await render();
    const signIn = originalTree.root.find(
      (node: any) => node.type === 'MonoButton' && node.props.label === 'Continue with GitHub',
    );

    await act(async () => {
      signIn.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sdk.finish).toHaveBeenCalledTimes(1);

    await act(async () => originalTree.unmount());
    const visibleTree = await render();
    await act(async () => {
      rejectBind(new OidcBindError('ticket_expired', 'The bind ticket expired', 410));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(noticeText(visibleTree)).toContain('SESSION EXPIRED · TICKET_EXPIRED');
  });
});
