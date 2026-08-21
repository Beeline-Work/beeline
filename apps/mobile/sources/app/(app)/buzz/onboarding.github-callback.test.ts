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
const identityStorage = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(async () => undefined),
  generate: vi.fn(async () => ({ secretKey: '1'.repeat(64), publicKey: '2'.repeat(64) })),
}));
const sdk = vi.hoisted(() => ({
  finish: vi.fn(async () => ({ linked: true })),
  getCapabilities: vi.fn(async () => ({ github: true, oidc: true })),
  listRepositories: vi.fn(async () => ({ installed: true, installations: [], repositories: [] })),
  lookupRecovery: vi.fn(
    async () => [] as { provider: string; subject: string; pubkey: string }[],
  ),
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
    buildOidcBindEvent: vi.fn(() => ({ id: 'bind-event' })),
    finishOidcBind: sdk.finish,
    getAuthCapabilities: sdk.getCapabilities,
    listGitHubRepositories: sdk.listRepositories,
    lookupRecovery: sdk.lookupRecovery,
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
  generateBuzzIdentity: identityStorage.generate,
  importBuzzIdentity: vi.fn(),
  loadBuzzIdentity: identityStorage.load,
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
  savePreferredPersonName: vi.fn(),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ relayUrl: 'https://relay.test' }),
}));
vi.mock('@/push/buzz-push-registration', () => ({
  registerBuzzPushNotifications: vi.fn(async () => undefined),
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => ({}));
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
    identityStorage.load.mockResolvedValue(null);
    sdk.getCapabilities.mockResolvedValue({ github: true, oidc: true });
    sdk.listRepositories.mockResolvedValue({ installed: true, installations: [], repositories: [] });
    sdk.lookupRecovery.mockResolvedValue([]);
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

  it('cold-starts, binds the proof, saves the identity, and enters the workspace', async () => {
    await persistGitHubSignInState(STATE);
    linking.initialUrl = callbackUrl();

    await render();

    expect(sdk.finish).toHaveBeenCalledTimes(1);
    expect(identityStorage.save).toHaveBeenCalledTimes(1);
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
