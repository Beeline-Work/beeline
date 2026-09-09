import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ secret: 'play-review-secret-value-0001' }));
const replace = vi.hoisted(() => vi.fn());
const signIn = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { Text: host('Text'), View: host('View') };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: (theme: any) => unknown) =>
      factory({
        buzz: {
          bgTerminal: '#000',
          muted: '#777',
          textPrimary: '#fff',
          textSecondary: '#aaa',
          type: { meta: {}, title: {}, body: {} },
          space: { md: 8, lg: 16 },
        },
      }),
  },
}));
vi.mock('expo-router', () => ({
  router: { replace },
  useLocalSearchParams: () => route,
}));
vi.mock('expo-linking', () => ({ useURL: () => null }));
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    PixelLoader: (props: any) => ReactModule.createElement('PixelLoader', props),
    MonoButton: (props: any) => ReactModule.createElement('MonoButton', props),
  };
});
vi.mock('@/auth/review-sign-in', () => ({ signInWithReviewSecret: signIn }));

import ReviewSignIn from './[secret]';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

async function renderRoute(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(ReviewSignIn));
    await Promise.resolve();
  });
  return renderer;
}

describe('review deep-link screen', () => {
  beforeEach(() => {
    route.secret = 'play-review-secret-value-0001';
    replace.mockReset();
    signIn.mockReset();
  });

  it('completes a valid review sign-in in the ordinary Rooms destination', async () => {
    signIn.mockResolvedValue('reviewer');
    await renderRoute();
    expect(signIn).toHaveBeenCalledWith(route.secret);
    expect(replace).toHaveBeenCalledWith('/beeline/channels');
  });

  it('shows an actionable error when the server refuses the review link', async () => {
    signIn.mockRejectedValue(new Error('not found'));
    const renderer = await renderRoute();
    expect(renderer.root.findByProps({ testID: 'review-sign-in-error' })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    const button = renderer.root.findByType('MonoButton');
    expect(button.props.label).toBe('Return to sign in');
    act(() => button.props.onPress());
    expect(replace).toHaveBeenCalledWith('/beeline/onboarding');
  });

  it('explains a malformed link without making an exchange request', async () => {
    route.secret = 'short';
    const renderer = await renderRoute();
    expect(signIn).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ testID: 'review-sign-in-error' })).toBeTruthy();
  });
});
