import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    Modal: host('Modal'),
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('react-native-keyboard-controller', async () => {
  const ReactModule = await import('react');
  return {
    KeyboardAvoidingView: (props: any) =>
      ReactModule.createElement('KeyboardAvoidingView', props, props.children),
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
const theme = vi.hoisted(() => ({
  buzz: {
    type: { body: { fontSize: 16 }, meta: { fontSize: 13 }, machine: { fontSize: 13 } },
    space: { xs: 4, sm: 8, md: 16, lg: 24 },
    layout: { row: 64 },
    radius: 3,
    accent: '#b08a4a',
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    absoluteFillObject: { position: 'absolute', inset: 0 },
    create: (factory: unknown) =>
      typeof factory === 'function' ? (factory as (value: any) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('./MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    BrassButton: host('BrassButton'),
    HullSurface: host('HullSurface'),
    PixelLoader: host('PixelLoader'),
  };
});
vi.mock('./IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});

import { MemberPickerSheet, type MemberPickerCandidate } from './MemberPickerSheet';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});
afterAll(() => vi.restoreAllMocks());

const OX = 'a'.repeat(64);
const ANA = 'b'.repeat(64);
const candidates: MemberPickerCandidate[] = [
  { pubkey: OX, name: 'Ox', handle: 'ox', kind: 'agent' },
  { pubkey: ANA, name: 'Ana', handle: 'ana', kind: 'person', face: 'fox' },
];

function baseProps() {
  return {
    visible: true,
    onClose: vi.fn(),
    candidates,
    canManage: true,
    busy: false,
    error: null,
    onAdd: vi.fn(),
    onInvitePerson: vi.fn(),
    onConnectAgent: vi.fn(),
    pairCommand: null,
    onCopyPairCommand: vi.fn(),
  };
}

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

function has(renderer: ReactTestRenderer, testID: string): boolean {
  return renderer.root.findAllByProps({ testID }).length > 0;
}

describe('MemberPickerSheet', () => {
  it('lists the Room-addable Workspace members as checkbox rows and adds the checked ones', () => {
    const props = baseProps();
    const renderer = render(<MemberPickerSheet {...props} />);

    expect(has(renderer, `member-picker-candidate-${OX}`)).toBe(true);
    expect(has(renderer, `member-picker-candidate-${ANA}`)).toBe(true);
    expect(has(renderer, 'member-picker-add')).toBe(false);
    expect(has(renderer, 'room-member-picker-empty')).toBe(false);
    // The tile states the kind; the row carries only the name and @handle.
    const agentRow = renderer.root
      .findAllByProps({ testID: `member-picker-candidate-${OX}` })
      .at(-1)!;
    expect(agentRow.props.accessibilityRole).toBe('checkbox');
    expect(agentRow.findByType('IdentityMark' as any).props.kind).toBe('agent');
    expect(agentRow.findAllByType('Text' as any).map((node: any) => node.props.children)).toEqual([
      'Ox',
      ['@', 'ox'],
    ]);

    act(() => agentRow.props.onPress());
    expect(renderer.root.findAllByProps({ testID: 'member-picker-add' }).at(-1)!.props.label).toBe(
      'Add 1',
    );
    act(() =>
      renderer.root
        .findAllByProps({ testID: `member-picker-candidate-${ANA}` })
        .at(-1)!
        .props.onPress(),
    );
    const add = renderer.root.findAllByProps({ testID: 'member-picker-add' }).at(-1)!;
    expect(add.props.label).toBe('Add 2');
    act(() => add.props.onPress());
    expect(props.onAdd).toHaveBeenCalledWith([OX, ANA]);
    // The Workspace-level ways in end the list, as they always did.
    expect(has(renderer, 'room-member-picker-invite-person')).toBe(true);
    expect(has(renderer, 'room-member-picker-add-agent')).toBe(true);
  });

  it('narrows to one kind for the slash verbs and forgets its checks when closed', () => {
    const props = baseProps();
    const renderer = render(<MemberPickerSheet {...props} kind="agent" />);
    expect(has(renderer, `member-picker-candidate-${OX}`)).toBe(true);
    expect(has(renderer, `member-picker-candidate-${ANA}`)).toBe(false);

    act(() =>
      renderer.root
        .findAllByProps({ testID: `member-picker-candidate-${OX}` })
        .at(-1)!
        .props.onPress(),
    );
    expect(has(renderer, 'member-picker-add')).toBe(true);
    act(() => {
      renderer.update(<MemberPickerSheet {...props} kind="agent" visible={false} />);
    });
    act(() => {
      renderer.update(<MemberPickerSheet {...props} kind="agent" visible />);
    });
    expect(has(renderer, 'member-picker-add')).toBe(false);
  });

  it('shows the loader, never the empty line, while the Workspace roster is in flight', () => {
    const renderer = render(<MemberPickerSheet {...baseProps()} candidates={null} />);
    expect(has(renderer, 'member-picker-loading')).toBe(true);
    expect(has(renderer, 'room-member-picker-empty')).toBe(false);
  });

  it('carries only the two Workspace-level ways in when no Room is in scope', () => {
    const renderer = render(
      <MemberPickerSheet
        {...baseProps()}
        candidates={undefined}
        pairCommand="npx usebeeline connect 1234ABCD-5678EF90"
      />,
    );
    expect(
      renderer.root.findAll((node: any) =>
        String(node.props.testID ?? '').startsWith('member-picker-candidate-'),
      ),
    ).toHaveLength(0);
    expect(has(renderer, 'member-picker-loading')).toBe(false);
    expect(has(renderer, 'room-member-picker-empty')).toBe(false);
    expect(has(renderer, 'room-member-picker-invite-person')).toBe(true);
    expect(has(renderer, 'room-member-picker-add-agent')).toBe(true);
    expect(
      renderer.root.findAllByProps({ testID: 'pair-agent-command' }).at(-1)!.props.children,
    ).toBe('npx usebeeline connect 1234ABCD-5678EF90');
  });

  it('shows the host error inline and tells a non-manager who to ask', () => {
    const renderer = render(
      <MemberPickerSheet {...baseProps()} canManage={false} error="Could not add @Ox: nope" />,
    );
    expect(
      renderer.root.findAllByProps({ testID: 'member-picker-error' }).at(-1)!.props.children,
    ).toEqual(['! ', 'Could not add @Ox: nope']);
    expect(has(renderer, 'room-member-picker-ask-manager')).toBe(true);
  });
});
