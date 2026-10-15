import React from 'react';
import { isRoomView } from '@beeline/buzz-client';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mobile = process.cwd();
const boundaries = require(path.join(mobile, 'offline-proof/boundaries.cjs')) as Record<
  string,
  string
>;
for (const [name, file] of Object.entries(boundaries)) {
  const target = name.startsWith('../') ? path.resolve(__dirname, name) : name;
  vi.doMock(
    target,
    () => import(/* @vite-ignore */ path.join(mobile, 'offline-proof/adapters', file)),
  );
}
vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) =>
    React.forwardRef((props: any, ref: any) =>
      React.createElement(name, { ...props, ref }, props.children),
    );
  const subscription = () => ({ remove() {} });
  return {
    View: host('View'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    Pressable: host('Pressable'),
    TouchableOpacity: host('TouchableOpacity'),
    ScrollView: host('ScrollView'),
    FlatList: React.forwardRef(({ data, renderItem, ...props }: any, ref: any) =>
      React.createElement(
        'FlatList',
        { ...props, ref },
        data?.map((item: any, index: number) =>
          React.createElement(React.Fragment, { key: item.id }, renderItem({ item, index })),
        ),
      ),
    ),
    ActivityIndicator: host('ActivityIndicator'),
    Image: host('Image'),
    Modal: (props: any) =>
      props.visible ? React.createElement('Modal', props, props.children) : null,
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    Platform: { OS: 'android', select: (o: any) => o.android ?? o.native ?? o.default },
    AppState: { currentState: 'active', addEventListener: subscription },
    Keyboard: { addListener: subscription, dismiss() {} },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    AccessibilityInfo: { isReduceMotionEnabled: async () => true, addEventListener: subscription },
    StyleSheet: {
      create: (s: any) => s,
      hairlineWidth: 1,
      absoluteFillObject: {},
      flatten: (s: any) => s,
    },
    Dimensions: {
      get: () => ({ width: 412, height: 915, scale: 1, fontScale: 1 }),
      addEventListener: subscription,
    },
    useWindowDimensions: () => ({ width: 412, height: 915, scale: 1, fontScale: 1 }),
    PixelRatio: { get: () => 1, roundToNearestPixel: (x: number) => x },
    Share: { share: async () => ({}) },
    Linking: { addEventListener: subscription, getInitialURL: async () => null },
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-notifications', () => ({
  addNotificationReceivedListener: () => ({ remove() {} }),
  getPresentedNotificationsAsync: async () => [],
}));
vi.mock('expo-image', async () => ({ Image: (await import('react-native')).Image }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-document-picker', () => ({}));
vi.mock('expo-image-manipulator', () => ({
  manipulateAsync: async () => ({}),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'proof/',
  EncodingType: { Base64: 'base64' },
}));
vi.mock('react-native-view-shot', () => ({ captureRef: async () => '', releaseCapture() {} }));
vi.mock('expo-sharing', () => ({}));
vi.mock('expo-web-browser', () => ({}));
vi.mock('react-native-gesture-handler', async () => {
  const { View } = await import('react-native');
  return { GestureDetector: View, GestureHandlerRootView: View, Swipeable: View, RectButton: View };
});
let renderer: any;
vi.setConfig({ testTimeout: 20000 });
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  if (renderer) {
    await act(async () => renderer.unmount());
    renderer = null;
  }
});
function text(node: any): string {
  if (typeof node === 'string') return node;
  if (!node) return '';
  return React.Children.toArray(node.props?.children)
    .map((child: any) => (typeof child === 'object' ? text(child) : String(child)))
    .join('');
}
function renderedText() {
  return renderer.root
    .findAll((node: any) => node.type === 'Text')
    .map(text)
    .join('\n');
}
async function settle() {
  for (let frame = 0; frame < 5; frame++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
}
it('page-offline-1: renders the cached transcript without an offline notice after a failed refresh', async () => {
  const { resetProof, failRefresh, controls, fixture } =
    await import('../../../../../offline-proof/adapters/services.js');
  expect(isRoomView(fixture)).toBe(true);
  resetProof();
  const { default: Page } = await import('./[channelId]');
  await act(async () => {
    renderer = create(<Page />);
  });
  await settle();
  expect(renderedText()).toContain('The saved conversation is still here.');
  expect(controls.reads).toBeGreaterThan(0);
  await act(async () => failRefresh());
  await settle();
  expect(renderedText()).toContain('The saved conversation is still here.');
  expect(renderedText()).not.toMatch(/Offline|last saved response/);
  expect(renderer.root.findAllByProps({ testID: 'room-saved-copy-notice' })).toHaveLength(0);
});
it('page-offline-1: failed initial load renders the production error screen and Retry recovers the transcript', async () => {
  const { resetProof, recoverServer } =
    await import('../../../../../offline-proof/adapters/services.js');
  resetProof(false);
  const { default: Page } = await import('./[channelId]');
  await act(async () => {
    renderer = create(<Page />);
  });
  await settle();
  expect(renderer.root.findAllByProps({ testID: 'room-hydration-error' }).length).toBeGreaterThan(
    0,
  );
  expect(renderedText()).toContain('Could not load this conversation.');
  recoverServer();
  const retry = renderer.root.findAll(
    (node: any) => node.type === 'Pressable' && node.props.onPress && text(node).includes('Retry'),
  )[0];
  expect(retry).toBeDefined();
  await act(async () => retry.props.onPress());
  await settle();
  expect(renderedText()).toContain('The saved conversation is still here.');
  expect(renderer.root.findAllByProps({ testID: 'room-hydration-error' })).toHaveLength(0);
});
