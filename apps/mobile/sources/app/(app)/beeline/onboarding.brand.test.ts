import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { beelineThemes } from '@/buzz/groknight';

/**
 * Canonical brand treatment on the login/onboarding surface (owner spec,
 * 2026-08-23): the wordmark reads exactly `beeline.` with the trailing period
 * in the theme accent (brass), and the login title/tagline/buttons plus the
 * auth notice surfaces use the app's canonical brand family (the theme's
 * Space Grotesk prose tokens) — no logo-font exception, no new fonts.
 */

const SOURCE_PATH = resolve(__dirname, 'onboarding.tsx');
const source = () => readFileSync(SOURCE_PATH, 'utf8');

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));

vi.mock('expo-router', () => ({ router: navigation }));
vi.mock('expo-linking', () => ({
  createURL: (p: string) => `beeline://${p}`,
  addEventListener: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: vi.fn(),
  openAuthSessionAsync: vi.fn(),
}));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/buzz/person-name', () => ({
  clearPersonNameOnboardingPending: vi.fn(async () => undefined),
  isPersonNameOnboardingPending: vi.fn(async () => false),
  loadPreferredPersonName: vi.fn(async () => null),
  markPersonNameOnboardingPending: vi.fn(async () => undefined),
  publishPreferredPersonName: vi.fn(async () => undefined),
  resolveOnboardingPersonName: vi.fn(async () => ({
    needsPrompt: false,
    name: 'Ada',
    communityId: 'w1',
  })),
  savePreferredPersonName: vi.fn(async () => undefined),
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
    hairlineDivider: { borderBottomWidth: 1, borderBottomColor: '#4e4e4e' },
    HullSurface: host('HullSurface'),
    PixelGateReveal: host('PixelGateReveal'),
  };
});
vi.mock('@/components/buzz/Button', async () => {
  const ReactModule = await import('react');
  return { Button: (props: any) => ReactModule.createElement('Button', props, props.children) };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Platform: {
      OS: 'ios',
      select: (choices: Record<string, unknown>) => choices.ios ?? choices.default,
    },
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// The Node test environment never runs React Native's entrypoint, so Expo's
// logger setup (pulled in through the onboarding import graph) needs __DEV__.
(globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = true;

const { default: BuzzOnboarding } = await import('./onboarding');

describe('onboarding — canonical brand treatment', () => {
  it('renders the wordmark as exactly "beeline." with a brass period glyph', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(BuzzOnboarding));
    });

    const marks = tree.root.findAll(
      (node: any) => typeof node.type === 'string' && node.props?.testID === 'onboarding-wordmark',
      { deep: true },
    );
    expect(marks).toHaveLength(1);
    const children = marks[0].props.children;
    expect(Array.isArray(children)).toBe(true);
    // The word itself…
    expect(children[0]).toBe('beeline');
    // …and its trailing period, styled with the theme accent (brass).
    const period = children[1];
    expect(period.props.children).toBe('.');
    expect(period.props.style.color).toBe(beelineThemes.obsidian.accent);
    expect(period.props.style.fontFamily).toBe('SpaceGrotesk-SemiBold');
  });

  it('renders the original sign-in tagline and full GitHub action', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(BuzzOnboarding));
    });

    const byTestID = (testID: string) =>
      tree.root.findAll(
        (node: any) => typeof node.type === 'string' && node.props?.testID === testID,
        { deep: true },
      );

    const canonical = 'SpaceGrotesk-SemiBold';

    const title = byTestID('onboarding-wordmark');
    expect(title).toHaveLength(1);
    expect(title[0].props.style.fontFamily).toBe(canonical);

    const tagline = byTestID('onboarding-tagline');
    expect(tagline).toHaveLength(1);
    expect(tagline[0].props.children).toBe('workspace for all intelligence');
    expect(tagline[0].props.style.fontFamily).toBe(beelineThemes.obsidian.proseRegular);
    expect(tagline[0].props.style.fontSize).toBe(beelineThemes.obsidian.type.body.fontSize);
    expect(tagline[0].props.style.lineHeight).toBe(beelineThemes.obsidian.type.body.lineHeight);

    // A rendered login action must keep its complete label and original button treatment.
    const signIn = tree.root.findAll(
      (node: any) => node.props?.testID === 'onboarding-github-sign-in',
    );
    expect(signIn.map((node: any) => node.type)).toContain('Button');
    expect(signIn.find((node: any) => node.type === 'Button')?.props.label).toBe(
      'Continue with GitHub',
    );

    // Every login-screen button is the shared Button, whose label face is
    // fixed by the component (DESIGN.md → Buttons): no per-call override.
    const buttons = tree.root.findAll(
      (node: any) => typeof node.type === 'string' && node.type === 'Button',
      { deep: true },
    );
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.props.labelStyle).toBeUndefined();
    }
  });
});

describe('onboarding — canonical brand source assertions', () => {
  it('keeps the wordmark period a separate accent-styled Text inside the title', () => {
    const src = source();
    expect(src).toContain('beeline<Text style={styles.titlePeriod}>.</Text>');
    expect(src).toMatch(/titlePeriod: \{[\s\S]*?color: groknight\.accent/);
  });

  it('never restores the logo font on the login title', () => {
    const src = source();
    const titleBlock = src.slice(src.indexOf('  title: {'), src.indexOf('titlePeriod:'));
    expect(titleBlock).toContain('groknight.proseSemibold');
    expect(titleBlock).not.toContain('Typography.logo()');
    // The tagline and the auth notice body keep the original canonical prose
    // family, now read through the shared body role (DESIGN.md → Type) rather
    // than a bare fontFamily line — body's family is still proseRegular.
    expect(src).toMatch(/subtitle: \{\s*\.\.\.theme\.buzz\.type\.body/);
    expect(src).toMatch(/noticeText: \{\s*\.\.\.theme\.buzz\.type\.body/);
  });

  it('renders every onboarding action through the one shared Button', () => {
    const src = source();
    expect(src.match(/<Button\n/g)?.length ?? 0).toBeGreaterThan(0);
    expect(src).not.toMatch(/<(MonoButton|BrassButton|OnboardingButton|RoundButton)\b/);
    expect(src).not.toContain('labelStyle=');
  });
});
