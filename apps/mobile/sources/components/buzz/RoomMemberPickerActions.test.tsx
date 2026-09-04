import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: (theme: unknown) => unknown) =>
      factory({
        buzz: {
          type: { body: { fontSize: 16 }, meta: { fontSize: 13 } },
          space: { sm: 8, md: 16 },
          layout: { row: 64 },
        },
      }),
  },
}));
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));

import { RoomMemberPickerActions } from './RoomMemberPickerActions';

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

function testIds(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node: any) => typeof node.type === 'string' && typeof node.props.testID === 'string')
    .map((node: any) => node.props.testID as string);
}

describe('RoomMemberPickerActions', () => {
  it('shows the empty line and both invite rows to a manager of a one-person workspace', () => {
    const onInvitePerson = vi.fn();
    const onAddAgent = vi.fn();
    const renderer = render(
      <RoomMemberPickerActions
        addableCount={0}
        busy={false}
        canManage
        onAddAgent={onAddAgent}
        onInvitePerson={onInvitePerson}
      />,
    );
    expect(testIds(renderer)).toEqual([
      'room-member-picker-actions',
      'room-member-picker-empty',
      'room-member-picker-invite-person',
      'room-member-picker-add-agent',
    ]);
    const empty = renderer.root.findAllByProps({ testID: 'room-member-picker-empty' }).at(-1)!;
    expect(empty.props.children).toBe('Nobody else in this workspace yet.');

    act(() => {
      renderer.root.findAllByProps({ testID: 'room-member-picker-invite-person' }).at(-1)!.props.onPress();
    });
    expect(onInvitePerson).toHaveBeenCalledTimes(1);
    expect(onAddAgent).not.toHaveBeenCalled();

    act(() => {
      renderer.root.findAllByProps({ testID: 'room-member-picker-add-agent' }).at(-1)!.props.onPress();
    });
    expect(onAddAgent).toHaveBeenCalledTimes(1);
  });

  it('tells a non-manager to ask a workspace manager instead of offering the actions', () => {
    const renderer = render(
      <RoomMemberPickerActions
        addableCount={0}
        busy={false}
        canManage={false}
        onAddAgent={vi.fn()}
        onInvitePerson={vi.fn()}
      />,
    );
    expect(testIds(renderer)).toEqual([
      'room-member-picker-actions',
      'room-member-picker-empty',
      'room-member-picker-ask-manager',
    ]);
    const ask = renderer.root.findAllByProps({ testID: 'room-member-picker-ask-manager' }).at(-1)!;
    expect(ask.props.children).toBe('Ask a workspace manager to invite people');
  });

  it('keeps the actions and drops the empty line once someone is addable', () => {
    const renderer = render(
      <RoomMemberPickerActions
        addableCount={2}
        busy={false}
        canManage
        onAddAgent={vi.fn()}
        onInvitePerson={vi.fn()}
      />,
    );
    expect(testIds(renderer)).toEqual([
      'room-member-picker-actions',
      'room-member-picker-invite-person',
      'room-member-picker-add-agent',
    ]);
  });

  it('disables both rows while an invite is in flight', () => {
    const renderer = render(
      <RoomMemberPickerActions
        addableCount={0}
        busy
        canManage
        onAddAgent={vi.fn()}
        onInvitePerson={vi.fn()}
      />,
    );
    const rows = renderer.root.findAllByType('TouchableOpacity' as any);
    expect(rows).toHaveLength(2);
    expect(rows.every((row: any) => row.props.disabled === true)).toBe(true);
  });
});
