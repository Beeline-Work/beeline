import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ isAuthenticated: false }));
const buzzIdentityStorage = vi.hoisted(() => ({ loadBuzzIdentity: vi.fn() }));
const desktopAuthSession = vi.hoisted(() => ({ initialAuthUrl: vi.fn() }));
const personName = vi.hoisted(() => ({ isPersonNameOnboardingPending: vi.fn() }));
const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/auth/buzz-identity-storage', () => buzzIdentityStorage);
vi.mock('@/auth/desktop-auth-session', () => desktopAuthSession);
vi.mock('expo-router', () => ({ router: navigation }));
vi.mock('@/buzz/person-name', () => personName);

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { Text: host('Text'), View: host('View') };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: any) =>
      factory({
        colors: { text: 'text', textSecondary: 'secondary' },
        // index.tsx reads the Beeline typography tokens for its prose.
        buzz: { proseRegular: 'proseRegular', proseSemibold: 'proseSemibold' },
      }),
  },
}));

vi.mock('@/components/RoundButton', async () => {
  const ReactModule = await import('react');
  return { RoundButton: (props: any) => ReactModule.createElement('RoundButton', props) };
});

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

import Home from '../app/(app)/index';

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
  auth.isAuthenticated = false;
  buzzIdentityStorage.loadBuzzIdentity.mockResolvedValue(null);
  desktopAuthSession.initialAuthUrl.mockResolvedValue(null);
  personName.isPersonNameOnboardingPending.mockResolvedValue(false);
});

async function renderHome() {
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(React.createElement(Home));
  });
  return renderer!;
}

describe('Buzz root launch routing', () => {
  it('routes a Happy-authenticated device without a Buzz identity to onboarding', async () => {
    auth.isAuthenticated = true;

    await renderHome();

    expect(navigation.replace).toHaveBeenCalledWith('/beeline/onboarding');
  });

  it('routes a device without credentials or a Buzz identity to onboarding', async () => {
    await renderHome();

    expect(navigation.replace).toHaveBeenCalledWith('/beeline/onboarding');
  });

  it('routes a device with a Buzz identity to channels', async () => {
    buzzIdentityStorage.loadBuzzIdentity.mockResolvedValue({ publicKey: 'buzz-user' });

    await renderHome();

    expect(navigation.replace).toHaveBeenCalledWith('/beeline/channels');
  });

  it('keeps a newly saved identity in onboarding until its name is set', async () => {
    buzzIdentityStorage.loadBuzzIdentity.mockResolvedValue({ publicKey: 'buzz-user' });
    personName.isPersonNameOnboardingPending.mockResolvedValue(true);

    await renderHome();

    expect(navigation.replace).toHaveBeenCalledWith('/beeline/onboarding');
    expect(navigation.replace).not.toHaveBeenCalledWith('/beeline/channels');
  });

  it('preserves a cold-start invite link instead of replacing it with the app root', async () => {
    const token = `bzi_${'ab'.repeat(32)}`;
    desktopAuthSession.initialAuthUrl.mockResolvedValue(`https://usebeeline.app/join/${token}`);
    buzzIdentityStorage.loadBuzzIdentity.mockResolvedValue({ publicKey: 'buzz-user' });

    await renderHome();

    expect(navigation.replace).toHaveBeenCalledWith({
      pathname: '/join/[token]',
      params: { token },
    });
    expect(navigation.replace).not.toHaveBeenCalledWith('/beeline/channels');
  });

  it.each([
    ['valid', 'play-review-secret-value-0001'],
    ['malformed', 'short'],
  ])('sends a %s cold desktop review link to its visible result route', async (_kind, secret) => {
    desktopAuthSession.initialAuthUrl.mockResolvedValue(`beeline://review/${secret}`);

    await renderHome();

    expect(navigation.replace).toHaveBeenCalledWith({
      pathname: '/review/[secret]',
      params: { secret },
    });
    expect(navigation.replace).not.toHaveBeenCalledWith('/beeline/onboarding');
  });

  it('renders the storage error instead of routing', async () => {
    buzzIdentityStorage.loadBuzzIdentity.mockRejectedValue(new Error('SecureStore unavailable'));

    const renderer = await renderHome();

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(
      renderer.root
        .findAllByType('Text' as any)
        .some((node) => node.props.children === 'Secure storage unavailable'),
    ).toBe(true);
  });
});
