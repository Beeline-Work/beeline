import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  platform: 'android', openURL: vi.fn(async () => {}), back: vi.fn(),
  foreground: null as null | ((state: string) => void),
}));
vi.mock('react-native', () => ({
  View: 'View', Text: 'Text', ScrollView: 'ScrollView',
  Platform: { get OS() { return state.platform; } },
  Linking: { openURL: state.openURL },
  BackHandler: { addEventListener: (_: string, handler: () => boolean) => { state.back = vi.fn(handler); return { remove: vi.fn() }; } },
  AppState: { addEventListener: (_: string, handler: (state: string) => void) => { state.foreground = handler; return { remove: vi.fn() }; } },
}));
vi.mock('expo-application', () => ({ nativeApplicationVersion: '0.2.22' }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.test' }) }));
vi.mock('@/components/buzz/Button', () => ({ Button: (props: unknown) => React.createElement('Button', props as object) }));
vi.mock('@/components/buzz/BeelineGlyphPaint', () => ({ BeelineGlyphPaint: () => null }));
import { StoreUpdateGate, StoreUpdateScreen } from './StoreUpdateGate';

afterEach(() => { vi.unstubAllGlobals(); state.platform = 'android'; state.openURL.mockClear(); });
const minimum = { minVersion: '0.2.24', reason: 'This version can no longer sign in.' };

it.each(['android', 'ios'] as const)('renders the approved copy and one store action on %s', async platform => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<StoreUpdateScreen platform={platform} installed="0.2.22" minimum={minimum} />); });
  const text = tree!.root.findAllByType('Text').flatMap((n: { props: { children: unknown } }) => n.props.children).join('');
  expect(text).toContain('Update Beeline to keep going');
  expect(text).toContain(minimum.reason);
  expect(text).toContain('0.2.22 → 0.2.24');
  const buttons = tree!.root.findAllByType('Button');
  expect(buttons).toHaveLength(1);
  expect(buttons[0].props.label).toBe(platform === 'android' ? 'Update on Google Play' : 'Update on the App Store');
  await act(async () => buttons[0].props.onPress());
  expect(state.openURL).toHaveBeenCalledWith(platform === 'android'
    ? 'https://play.google.com/store/apps/details?id=app.usebeeline' : 'https://apps.apple.com/app/id6803948500');
  await act(async () => tree!.unmount());
});

it('replaces navigation below the minimum, consumes Back and opens normally at equal or unset minimums', async () => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ android: minimum })));
  vi.stubGlobal('fetch', request);
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<StoreUpdateGate><div>Room list</div></StoreUpdateGate>); });
  expect(tree!.root.findAllByProps({ testID: 'store-update-required' })).toHaveLength(1);
  expect(tree!.root.findAllByType('div')).toHaveLength(0);
  expect(state.back()).toBe(true);
  request.mockResolvedValueOnce(new Response(JSON.stringify({ android: { ...minimum, minVersion: '0.2.22' } })));
  await act(async () => { state.foreground?.('active'); });
  expect(tree!.root.findAllByType('div')).toHaveLength(1);
  request.mockResolvedValueOnce(new Response('{}'));
  await act(async () => { state.foreground?.('active'); });
  expect(tree!.root.findAllByType('div')).toHaveLength(1);
  await act(async () => tree!.unmount());
});

it('leaves the web navigator mounted without a policy request', async () => {
  state.platform = 'web';
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<StoreUpdateGate><div>Room list</div></StoreUpdateGate>); });
  expect(tree!.root.findAllByType('div')).toHaveLength(1);
  expect(request).not.toHaveBeenCalled();
  await act(async () => tree!.unmount());
});

it('waits for the root font-ready signal before measuring the store action', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ android: minimum }))));
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<StoreUpdateGate fontsReady={false}><div>Starting</div></StoreUpdateGate>); });
  expect(tree!.root.findAllByProps({ testID: 'store-update-required' })).toHaveLength(0);
  await act(async () => { tree!.update(<StoreUpdateGate fontsReady><div>Starting</div></StoreUpdateGate>); });
  expect(tree!.root.findAllByProps({ testID: 'store-update-required' })).toHaveLength(1);
  await act(async () => tree!.unmount());
});
