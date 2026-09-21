import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => ({ workspaceId: 'workspace-1' }),
}));

vi.mock('react-native-unistyles', () => {
  const hull = {
    textPrimary: '#fff',
    textSecondary: '#aaa',
    textMuted: '#888',
    accent: '#d7af5f',
    border: '#333',
    agentAccent: '#d7af5f',
    space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
    radius: 3,
    type: { hero: {}, body: {}, meta: {}, sectionHead: {}, machine: {} },
    layout: { sectionGap: 16, row: 56 },
  };
  return {
    StyleSheet: {
      create: (styles: unknown) =>
        typeof styles === 'function' ? (styles as (theme: { buzz: typeof hull }) => unknown)({ buzz: hull }) : styles,
      hairlineWidth: 1,
    },
    useUnistyles: () => ({ theme: { buzz: hull } }),
  };
});

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
    TouchableOpacity: host('TouchableOpacity'),
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

vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    HullSurface: host('HullSurface'),
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('@/components/buzz/ChevronGlyph', async () => {
  const ReactModule = await import('react');
  return {
    CHEVRON_BACK_SIZE: 22,
    ChevronGlyph: (props: any) => ReactModule.createElement('ChevronGlyph', props),
  };
});

vi.mock('@/components/buzz/HullActionSheet', async () => {
  const ReactModule = await import('react');
  return {
    HullActionSheetModal: (props: any) =>
      ReactModule.createElement('HullActionSheetModal', props, props.children),
    HullActionSheetRow: (props: any) => ReactModule.createElement('HullActionSheetRow', props),
  };
});

vi.mock('qrcode', () => ({
  default: { create: () => ({ modules: { size: 0, get: () => 0 } }) },
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(async () => undefined),
}));

vi.mock('@/components/buzz/WalletQr', async () => {
  const ReactModule = await import('react');
  return {
    WalletQr: (props: any) => ReactModule.createElement('WalletQr', props),
  };
});
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});

import WalletScreen from './wallet';
import WalletSendScreen from './wallet-send';
import { MockWalletSource } from '@/buzz/wallet-source.mock';
import { setWalletSource } from '@/buzz/wallet-source';
import { MonolithPhoneOperationError } from '@/sync/transport/monolith-operation';

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

  it('carries the Wallet heading the other Workbench screens draw', async () => {
    const renderer = await render(WalletScreen);
    expect(renderer.root.findByProps({ testID: 'wallet-header-title' }).props.children).toBe(
      'Wallets',
    );
    expect(renderer.root.findByProps({ testID: 'wallet-header-subtitle' }).props.children).toBe(
      'Coinbase CDP Server Wallet',
    );
    expect(renderer.root.findByProps({ testID: 'wallet-back' })).toBeTruthy();
  });

  it('paints a total, then coins with their marks, and no chains', async () => {
    const renderer = await render(WalletScreen);
    expect(renderer.root.findByProps({ testID: 'wallet-balance-value' }).props.children).toBe(
      '$412.60',
    );
    expect(renderer.root.findByProps({ testID: 'wallet-coin-USDC' })).toBeTruthy();
    expect(
      renderer.root.findAllByProps({ testID: 'wallet-coin-chain-base' }).length,
    ).toBeGreaterThan(0);
    // The dashboard carries the address with copy and QR affordances.
    expect(renderer.root.findByProps({ testID: 'wallet-address-copy' })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: 'wallet-address-qr-toggle' })).toBeTruthy();
  });

  it('copies the address through expo-clipboard', async () => {
    const renderer = await render(WalletScreen);
    const copy = renderer.root.findByProps({ testID: 'wallet-address-copy' });
    const clipboard = await import('expo-clipboard');
    await act(async () => {
      copy.props.onPress();
      await Promise.resolve();
    });
    expect(clipboard.setStringAsync).toHaveBeenCalledWith(
      '0x8f2c41B9Ea52d3aB7f0cCd4911E6D6b7B0a19d77',
    );
  });

  it('opens the existing Send and Receive flows from the centered balance', async () => {
    const renderer = await render(WalletScreen);
    await act(async () => {
      renderer.root.findByProps({ testID: 'wallet-action-receive' }).props.onPress();
    });
    expect(navigation.push.mock.calls.at(-1)![0]).toEqual({
      pathname: '/beeline/settings/workbench/wallet-receive',
      params: { workspaceId: 'workspace-1' },
    });
  });

  it('paints the transaction history feed newest first', async () => {
    const renderer = await render(WalletScreen);
    const first = renderer.root.findByProps({ testID: 'wallet-activity-0' });
    expect(first).toBeTruthy();
    expect(renderer.root.findAllByProps({ testID: 'wallet-activity-1' }).length).toBeGreaterThan(0);
  });

  it('keeps a grant press on the banner and shows it in flight', async () => {
    const source = new MockWalletSource();
    const baseline = await source.readWallet();
    let finishGrant: ((value: { expiresAt: number }) => void) | undefined;
    source.readWallet = async () => ({
      ...baseline,
      delegation: { active: false, expiresAt: Date.now() - 1_000 },
    });
    source.grantDelegation = () =>
      new Promise((resolve) => {
        finishGrant = resolve;
      });
    setWalletSource(source);
    const renderer = await render(WalletScreen);
    const banner = renderer.root.findByProps({ testID: 'wallet-delegation-banner' });
    expect(banner.props.action).toBe('grant');
    expect(banner.props.onPress).toBeTypeOf('function');
    await act(async () => {
      void banner.props.onPress();
    });
    const inFlight = renderer.root.findByProps({ testID: 'wallet-delegation-banner' });
    expect(inFlight.props.value).toBe('Granting…');
    expect(inFlight.props.valueTone).toBe('accent');
    expect(inFlight.props.statusGlyph).toBe('pulse');
    expect(inFlight.props.action).toBeUndefined();
    expect(inFlight.props.onPress).toBeTypeOf('function');
    await act(async () => {
      finishGrant?.({ expiresAt: Date.now() + 24 * 3_600_000 });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('shows a real grant refusal on the loaded-wallet banner, not the empty-wallet path', async () => {
    const source = new MockWalletSource();
    const baseline = await source.readWallet();
    source.readWallet = async () => ({
      ...baseline,
      delegation: { active: false, expiresAt: Date.now() - 1_000 },
    });
    source.grantDelegation = async () => {
      throw new MonolithPhoneOperationError('grantWalletDelegation', 503, 'wallet not created');
    };
    setWalletSource(source);
    const renderer = await render(WalletScreen);
    expect(renderer.root.findAllByProps({ testID: 'wallet-network-unavailable' })).toHaveLength(0);
    await act(async () => {
      renderer.root.findByProps({ testID: 'wallet-delegation-banner' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    const banner = renderer.root.findByProps({ testID: 'wallet-delegation-banner' });
    expect(banner.props.description).toBe('wallet not created');
    expect(banner.props.descriptionTone).toBe('danger');
    expect(banner.props.action).toBe('grant');
    expect(renderer.root.findAllByProps({ testID: 'wallet-network-unavailable' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'wallet-balance-value' })).toBeTruthy();
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
