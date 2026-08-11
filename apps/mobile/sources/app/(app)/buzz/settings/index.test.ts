import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const identityStorage = vi.hoisted(() => ({ clearBuzzIdentity: vi.fn(async () => undefined) }));

vi.mock('expo-router', () => ({ router: navigation }));
vi.mock('@/auth/buzz-identity-storage', () => identityStorage);
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { HullSurface: host('HullSurface'), PixelGateReveal: host('PixelGateReveal') };
});

import BuzzSettings from './index';

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

function render(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(BuzzSettings));
  });
  return renderer;
}

describe('Buzz global Settings', () => {
  it('contains key backup and forget actions without relay switching', async () => {
    const renderer = render();
    const text = renderer.root
      .findAllByType('Text' as any)
      .flatMap((node) => node.props.children)
      .join(' ');

    expect(text).toContain('Back up your key');
    expect(text).toContain('Forget key');
    expect(text).not.toContain('Relay URL');

    act(() => renderer.root.findByProps({ testID: 'backup-key-setting' }).props.onPress());
    expect(navigation.push).toHaveBeenCalledWith('/buzz/settings/identity');

    await act(async () => {
      await renderer.root.findByProps({ testID: 'forget-key-setting' }).props.onPress();
    });
    expect(identityStorage.clearBuzzIdentity).not.toHaveBeenCalled();
    await act(async () => {
      await renderer.root.findByProps({ testID: 'forget-key-setting' }).props.onPress();
    });
    expect(identityStorage.clearBuzzIdentity).toHaveBeenCalledOnce();
    expect(navigation.replace).toHaveBeenCalledWith('/buzz/onboarding');
  });
});
