import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ForwardTarget } from '@/buzz/message-forward';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TextInput: host('TextInput'),
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useUnistyles: () => ({ theme: { buzz: { textMuted: '#777' } } }),
}));

vi.mock('@/constants/Typography', () => ({
  Typography: {
    default: () => ({}),
    mono: () => ({}),
  },
}));

vi.mock('./HullActionSheet', () => ({
  HULL_SHEET_INSET: 22,
  HullActionSheetCancel: (props: any) =>
    React.createElement('HullActionSheetCancel', props, props.children),
  HullActionSheetModal: (props: any) =>
    React.createElement('HullActionSheetModal', props, props.children),
  HullActionSheetRow: (props: any) =>
    React.createElement('HullActionSheetRow', props, props.children),
}));

import { ForwardMessagePickerSheet } from './ForwardMessagePickerSheet';

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

const targets: ForwardTarget[] = [
  { kind: 'room', id: 'room', label: '#general', group: 'rooms' },
  { kind: 'room', id: 'person-dm', label: '@Alice', group: 'people' },
  {
    kind: 'member',
    id: 'agent-new',
    label: '@Bee',
    memberId: 'agent-new',
    group: 'agents',
  },
];

describe('forward message picker', () => {
  it('groups destinations as People, Agents, then Rooms and preserves selection', () => {
    const onForward = vi.fn();
    const renderer = render(
      React.createElement(ForwardMessagePickerSheet, {
        busyRoomId: null,
        error: null,
        onClose: vi.fn(),
        onForward,
        targets,
        visible: true,
      }),
    );

    const headings = renderer.root
      .findAll((node) => node.type === 'Text' && node.props.accessibilityRole === 'header')
      .map((node) => node.props.children);
    expect(headings).toEqual(['PEOPLE', 'AGENTS', 'ROOMS']);

    act(() => renderer.root.findByProps({ testID: 'forward-member-agent-new' }).props.onPress());
    expect(onForward).toHaveBeenCalledWith(targets[2]);
  });

  it('filters across groups without flattening the remaining section', () => {
    const renderer = render(
      React.createElement(ForwardMessagePickerSheet, {
        busyRoomId: null,
        error: null,
        onClose: vi.fn(),
        onForward: vi.fn(),
        targets,
        visible: true,
      }),
    );

    act(() =>
      renderer.root.findByProps({ testID: 'forward-room-search' }).props.onChangeText('GEN'),
    );

    const headings = renderer.root
      .findAll((node) => node.type === 'Text' && node.props.accessibilityRole === 'header')
      .map((node) => node.props.children);
    expect(headings).toEqual(['ROOMS']);
    expect(renderer.root.findByProps({ testID: 'forward-room-room' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'forward-room-person-dm' })).toHaveLength(0);
  });

  it('reports an empty search and clears it when the sheet closes', () => {
    const props = {
      busyRoomId: null,
      error: null,
      onClose: vi.fn(),
      onForward: vi.fn(),
      targets,
      visible: true,
    };
    const renderer = render(React.createElement(ForwardMessagePickerSheet, props));

    act(() =>
      renderer.root.findByProps({ testID: 'forward-room-search' }).props.onChangeText('nobody'),
    );
    expect(
      renderer.root.findByProps({ children: 'No destinations match “nobody”.' }),
    ).toBeDefined();

    act(() =>
      renderer.update(React.createElement(ForwardMessagePickerSheet, { ...props, visible: false })),
    );
    expect(renderer.root.findByProps({ testID: 'forward-room-search' }).props.value).toBe('');
  });
});
