import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
    theme: {
      buzz: {
        space: { md: 16 },
        radius: 3,
        borderStrong: '#333',
        bgTerminal: '#111',
        textPrimary: '#fff',
        textMuted: '#888',
        type: { body: { fontSize: 16 }, meta: { fontSize: 13 } },
      },
    },
  }),
  StyleSheet: {
    create: (factory: (theme: unknown) => unknown) =>
      factory({
        buzz: {
          space: { md: 16 },
          radius: 3,
          borderStrong: '#333',
          bgTerminal: '#111',
          textPrimary: '#fff',
          textMuted: '#888',
          type: { body: { fontSize: 16 }, meta: { fontSize: 13 } },
        },
      }),
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import {
  presentForegroundPushNotice,
  resetForegroundPushNoticeForTests,
  setForegroundPushOpenHandler,
} from '@/push/foreground-push-notice';

import { ForegroundPushToast } from './ForegroundPushToast';

function textOf(node: { props?: { children?: unknown } }): string {
  const children = node.props?.children;
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (!Array.isArray(children))
    return children ? textOf(children as { props?: { children?: unknown } }) : '';
  return children
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : child
          ? textOf(child as { props?: { children?: unknown } })
          : '',
    )
    .join('');
}

describe('ForegroundPushToast', () => {
  it('shows the push title and body, then opens on tap', () => {
    resetForegroundPushNoticeForTests();
    const opened: string[] = [];
    setForegroundPushOpenHandler((notice) => opened.push(notice.identifier));
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(<ForegroundPushToast />);
    });
    expect(renderer!.toJSON()).toBeNull();

    act(() => {
      presentForegroundPushNotice({
        identifier: 'msg-9',
        title: 'Beeline',
        body: 'hello from general',
        data: { channelId: 'room-general' },
      });
    });
    const plate = renderer!.root.findByProps({ testID: 'foreground-push-notice' });
    expect(textOf(plate)).toBe('Beelinehello from general');

    act(() => {
      plate.props.onPress();
    });
    expect(opened).toEqual(['msg-9']);
    expect(renderer!.toJSON()).toBeNull();
    act(() => {
      renderer!.unmount();
    });
  });
});
