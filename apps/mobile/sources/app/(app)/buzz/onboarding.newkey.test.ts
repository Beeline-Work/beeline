import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadIdentityFromNsec } from '@beeline/buzz-client';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const secure = vi.hoisted(() => new Map<string, string>());
const secureSet = vi.hoisted(() => vi.fn());
const clipboard = vi.hoisted(() => vi.fn(async () => true));
const personName = vi.hoisted(() => ({
  clear: vi.fn(async () => undefined),
  pending: vi.fn(async () => false),
  mark: vi.fn(async () => undefined),
  resolve: vi.fn(async () => ({ needsPrompt: false, name: 'Ada', communityId: 'w1' })),
}));

vi.mock('expo-router', () => ({ router: navigation }));
vi.mock('expo-linking', () => ({ createURL: (p: string) => `beeline://${p}`, addEventListener: vi.fn(() => ({ remove: vi.fn() })) }));
vi.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: vi.fn(), openAuthSessionAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  setItemAsync: async (key: string, value: string) => {
    secureSet(key, value);
    secure.set(key, value);
  },
  getItemAsync: async (key: string) => secure.get(key) ?? null,
  deleteItemAsync: async (key: string) => void secure.delete(key),
}));
vi.mock('@/buzz/person-name', () => ({
  clearPersonNameOnboardingPending: personName.clear,
  isPersonNameOnboardingPending: personName.pending,
  loadPreferredPersonName: vi.fn(async () => null),
  markPersonNameOnboardingPending: personName.mark,
  publishPreferredPersonName: vi.fn(async () => undefined),
  resolveOnboardingPersonName: personName.resolve,
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
    MonoButton: host('MonoButton'),
    PixelGateReveal: host('PixelGateReveal'),
  };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios ?? choices.default },
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { default: BuzzOnboarding } = await import('./onboarding');

function nodes(tree: ReactTestRenderer, testID: string) {
  // Host elements only: `findAll` also returns the composite instance that
  // rendered them, so every match would otherwise be counted twice.
  return tree.root.findAll(
    (node: any) => typeof node.type === 'string' && node.props?.testID === testID,
    { deep: true },
  );
}

function one(tree: ReactTestRenderer, testID: string) {
  const found = nodes(tree, testID);
  expect(found, `expected exactly one ${testID}`).toHaveLength(1);
  return found[0];
}

function textOf(tree: ReactTestRenderer, testID: string): string {
  // Read `.props.children`, never `.children` — see CLAUDE.md's note on
  // pretty-format recursing into the Fiber graph and OOMing the worker.
  const children = one(tree, testID).props.children;
  return Array.isArray(children) ? children.join('') : String(children);
}

async function press(node: any) {
  await act(async () => {
    node.props.onPress?.();
  });
}

async function render(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(BuzzOnboarding));
  });
  return tree;
}

/** Open Advanced, then create a key. */
async function openNewKeyStep(): Promise<ReactTestRenderer> {
  const tree = await render();
  await press(one(tree, 'onboarding-advanced'));
  await press(one(tree, 'onboarding-create-key'));
  return tree;
}

describe('onboarding — create a new key', () => {
  beforeEach(() => {
    secure.clear();
    secureSet.mockClear();
    navigation.replace.mockClear();
    clipboard.mockClear();
  });

  it('offers a create-new-key action beside the existing-key import', async () => {
    const tree = await render();
    // The dead end this closes: before Advanced was opened there is no key path
    // at all for a new-key user, and inside it there was only "Import key".
    expect(nodes(tree, 'onboarding-create-key')).toHaveLength(0);
    await press(one(tree, 'onboarding-advanced'));
    expect(nodes(tree, 'onboarding-create-key')).toHaveLength(1);
    expect(nodes(tree, 'onboarding-import-key')).toHaveLength(1);
  });

  it('generates a real key, shows its npub, and masks the secret', async () => {
    const tree = await openNewKeyStep();

    expect(nodes(tree, 'onboarding-new-key-step')).toHaveLength(1);
    const npub = textOf(tree, 'onboarding-new-key-npub');
    expect(npub).toMatch(/^npub1[0-9a-z]{20,}$/);
    const masked = textOf(tree, 'onboarding-new-key-nsec');
    expect(masked).toMatch(/^nsec1•+$/);
  });

  it('does not persist the key while the backup step is unfinished', async () => {
    await openNewKeyStep();
    expect(secureSet).not.toHaveBeenCalled();
  });

  it('gates entry on reveal-or-copy AND the explicit confirmation', async () => {
    const tree = await openNewKeyStep();

    // 1. Fresh draft: the checkbox is inert and the door is shut.
    expect(one(tree, 'onboarding-new-key-confirm').props.disabled).toBe(true);
    expect(one(tree, 'onboarding-new-key-enter').props.disabled).toBe(true);

    // 2. Tapping the inert checkbox cannot open the door.
    await press(one(tree, 'onboarding-new-key-confirm'));
    expect(one(tree, 'onboarding-new-key-enter').props.disabled).toBe(true);

    // 3. Revealing the key un-inerts the checkbox but is not itself consent.
    await press(one(tree, 'onboarding-new-key-reveal'));
    expect(textOf(tree, 'onboarding-new-key-nsec')).toMatch(/^nsec1[0-9a-z]{20,}$/);
    expect(one(tree, 'onboarding-new-key-confirm').props.disabled).toBe(false);
    expect(one(tree, 'onboarding-new-key-enter').props.disabled).toBe(true);

    // 4. Only both together open it.
    await press(one(tree, 'onboarding-new-key-confirm'));
    expect(one(tree, 'onboarding-new-key-confirm').props.accessibilityState.checked).toBe(true);
    expect(one(tree, 'onboarding-new-key-enter').props.disabled).toBe(false);

    // Still nothing on disk until the button is actually pressed.
    expect(secureSet).not.toHaveBeenCalled();
  });

  it('accepts a copy as the backup step too', async () => {
    const tree = await openNewKeyStep();
    await press(one(tree, 'onboarding-new-key-copy'));

    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(String(clipboard.mock.calls[0][0])).toMatch(/^nsec1[0-9a-z]{20,}$/);
    expect(one(tree, 'onboarding-new-key-confirm').props.disabled).toBe(false);
  });

  it('persists the shown key and enters the app once confirmed', async () => {
    const tree = await openNewKeyStep();
    const shownNpub = textOf(tree, 'onboarding-new-key-npub');
    await press(one(tree, 'onboarding-new-key-reveal'));
    const shownNsec = textOf(tree, 'onboarding-new-key-nsec');
    await press(one(tree, 'onboarding-new-key-confirm'));
    await press(one(tree, 'onboarding-new-key-enter'));

    expect(secureSet).toHaveBeenCalledTimes(1);
    const [, storedNsec] = secureSet.mock.calls[0];
    // The key that was displayed and backed up is the key that got stored.
    expect(storedNsec).toBe(shownNsec);
    expect(loadIdentityFromNsec(String(storedNsec)).publicKey).toBe(
      loadIdentityFromNsec(shownNsec).publicKey,
    );
    expect(shownNpub).toMatch(/^npub1/);
    expect(navigation.replace).toHaveBeenCalledWith('/buzz/channels');
  });

  it('discards a draft without leaving anything behind', async () => {
    const tree = await openNewKeyStep();
    await press(one(tree, 'onboarding-new-key-discard'));

    expect(nodes(tree, 'onboarding-new-key-step')).toHaveLength(0);
    expect(nodes(tree, 'onboarding-create-key')).toHaveLength(1);
    expect(secureSet).not.toHaveBeenCalled();
  });
});
