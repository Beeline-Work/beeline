import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => ({ workspaceId: 'workspace-1' }),
}));

vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useUnistyles: () => ({ theme: {} }),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TextInput: host('TextInput'),
    Pressable: host('Pressable'),
    View: host('View'),
    Image: host('Image'),
  };
});

vi.mock('@/components/buzz/SettingsRow', async () => {
  const ReactModule = await import('react');
  return {
    SettingsRow: (props: any) => ReactModule.createElement('SettingsRow', props),
  };
});

vi.mock('@/components/buzz/HullActionSheet', async () => {
  const ReactModule = await import('react');
  return {
    HullActionSheetModal: (props: any) =>
      ReactModule.createElement('HullActionSheetModal', props, props.children),
    HullActionSheetRow: (props: any) =>
      ReactModule.createElement('HullActionSheetRow', props),
  };
});

vi.mock('qrcode', () => ({
  default: { create: () => ({ modules: { size: 0, get: () => 0 } }) },
}));

import WalletScreen from './wallet';
import WalletSendScreen from './wallet-send';
import { MockWalletSource } from '@/buzz/wallet-source.mock';
import { setWalletSource } from '@/buzz/wallet-source';

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

describe('Wallet screens (mock §Screens, pass 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setWalletSource(new MockWalletSource());
  });

  async function render(screen: React.ComponentType): Promise<ReactTestRenderer> {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(screen));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    return renderer;
  }

  it('paints a total, then coins with their marks, and no chains', async () => {
    const renderer = await render(WalletScreen);
    expect(renderer.root.findByProps({ testID: 'wallet-balance' }).props.children.props.children).toBe('$412.60');
    expect(renderer.root.findByProps({ testID: 'wallet-coin-USDC' })).toBeTruthy();
    expect(() => renderer.root.findByProps({ testID: 'wallet-chain-base' })).toThrow();
  });

  it('the send screen refuses with the only named refusal: not enough of the asset', async () => {
    const renderer = await render(WalletSendScreen);
    const amount = renderer.root.findByProps({ testID: 'wallet-send-amount' });
    const to = renderer.root.findByProps({ testID: 'wallet-send-to' });
    await act(async () => {
      amount.props.onChangeText('999999');
      to.props.onChangeText('0xabc');
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'wallet-send-confirm' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    const outcome = renderer.root.findByProps({ testID: 'wallet-send-outcome' });
    expect(String(outcome.props.children)).toContain('Not enough');
  });

});
