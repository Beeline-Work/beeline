import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('@/constants/Typography', () => ({
  Typography: {
    default: () => () => ({}),
    mono: () => () => ({}),
    sans: () => () => ({}),
  },
}));

vi.mock('./IdentityMark', () => ({
  IdentityMark: (props: any) => React.createElement('IdentityMark', props),
}));

vi.mock('./HullActionSheet', () => ({
  HullActionSheetCancel: (props: any) =>
    React.createElement('HullActionSheetCancel', props, props.children),
  HullActionSheetModal: (props: any) =>
    React.createElement('HullActionSheetModal', props, props.children),
}));

import { DirectMessagePickerSheet } from './DirectMessagePickerSheet';

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

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

const members = [
  { peerPubkey: 'pubkey-alice', peerName: 'Alice', peerKind: 'person' },
  { peerPubkey: 'pubkey-bob', peerName: 'Bob', peerKind: 'person' },
  { peerPubkey: 'pubkey-agent', peerName: 'Bee', peerKind: 'agent' },
];

describe('direct message picker', () => {
  it('lists agents as well as people and opens the agent DM', () => {
    const onMessage = vi.fn();
    const renderer = render(
      React.createElement(DirectMessagePickerSheet, {
        busyPubkey: null,
        members,
        onClose: vi.fn(),
        onMessage,
        visible: true,
      }),
    );

    expect(renderer.root.findByProps({ testID: 'direct-message-picker' })).toBeDefined();
    expect(
      renderer.root.findByProps({ testID: 'message-workspace-member-pubkey-agent' }),
    ).toBeDefined();
    expect(
      renderer.root.findByProps({ testID: 'message-workspace-member-pubkey-alice' }),
    ).toBeDefined();
    act(() =>
      renderer.root
        .findByProps({ testID: 'message-workspace-member-pubkey-agent' })
        .props.onPress(),
    );
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(members[2]);
  });

  it('offers the close action with no other members', () => {
    const renderer = render(
      React.createElement(DirectMessagePickerSheet, {
        busyPubkey: 'pubkey-agent',
        members: [],
        onClose: vi.fn(),
        onMessage: vi.fn(),
        visible: true,
      }),
    );
    expect(renderer.root.findByProps({ testID: 'direct-message-picker-close' })).toBeDefined();
  });
});
