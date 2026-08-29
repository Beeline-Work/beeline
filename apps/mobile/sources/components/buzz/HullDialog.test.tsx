import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const theme = vi.hoisted(() => ({
  hull: {
    accent: '#b08a4a',
    bgPressed: '#2a1b31',
    bgRaised: '#1d1024',
    bgTerminal: '#14091a',
    border: '#39273f',
    borderStrong: '#594361',
    chrome: '#f1edf2',
    dialogDanger: '#c4544d',
    proseRegular: 'GrokRegular',
    proseSemibold: 'GrokSemibold',
    radius: 3,
    textDisabled: '#75687a',
    textInverted: '#14091a',
    textPrimary: '#f1edf2',
    textSecondary: '#aaa0ae',
  },
}));

const modalRenderSpy = vi.hoisted(() => vi.fn());
const surfaceRenderSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    Modal: (props: any) => {
      modalRenderSpy();
      return ReactModule.createElement('Modal', props, props.children);
    },
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    Text: host('Text'),
    TextInput: ReactModule.forwardRef((props: any, _ref) =>
      ReactModule.createElement('TextInput', props),
    ),
    View: host('View'),
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    absoluteFill: { position: 'absolute', inset: 0 },
    absoluteFillObject: { position: 'absolute', inset: 0 },
    create: (factory: unknown) =>
      typeof factory === 'function'
        ? (factory as (theme: any) => unknown)({ buzz: theme.hull })
        : factory,
    hairlineWidth: 1,
  },
  useUnistyles: () => ({ theme: { buzz: theme.hull } }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 12, left: 0 }),
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('./MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    HullSurface: (props: any) => {
      surfaceRenderSpy();
      return ReactModule.createElement('HullSurface', props, props.children);
    },
  };
});

import { HullDialog, HullDialogInput } from './HullDialog';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';
import { HullMenuTrigger } from './HullMenuTrigger';

const hull = theme.hull;

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

function hostByTestID(renderer: ReactTestRenderer, testID: string, type: string) {
  return renderer.root.findAllByProps({ testID }).find((node: any) => node.type === type)!;
}

describe('Hull dialog family', () => {
  it('renders quiet, single-brass primary, and red destructive actions with modal dismissal semantics', () => {
    const onClose = vi.fn();
    const cancel = vi.fn();
    const save = vi.fn();
    const remove = vi.fn();
    const renderer = render(
      <HullDialog
        actions={[
          { label: 'Cancel', onPress: cancel, testID: 'cancel', variant: 'quiet' },
          { label: 'Save', onPress: save, testID: 'save', variant: 'primary' },
          { label: 'Alternate', onPress: vi.fn(), testID: 'alternate', variant: 'primary' },
          { label: 'Remove', onPress: remove, testID: 'remove', variant: 'destructive' },
        ]}
        body="This cannot be undone."
        onRequestClose={onClose}
        scrimTestID="dialog-scrim"
        title="Remove Room?"
        visible
      />,
    );

    expect(renderer.root.findByType('Modal' as any).props).toMatchObject({
      transparent: true,
      visible: true,
      onRequestClose: expect.any(Function),
    });
    expect(
      hostByTestID(renderer, 'save', 'Pressable').props.style({ pressed: false }),
    ).toContainEqual({ backgroundColor: hull.accent });
    expect(
      hostByTestID(renderer, 'remove', 'Pressable').findByType('Text' as any).props.style,
    ).toContainEqual({ color: hull.dialogDanger });
    expect(
      hostByTestID(renderer, 'cancel', 'Pressable').props.style({ pressed: false }),
    ).not.toContainEqual({ backgroundColor: hull.accent });
    expect(
      hostByTestID(renderer, 'alternate', 'Pressable').props.style({ pressed: false }),
    ).not.toContainEqual({ backgroundColor: hull.accent });

    act(() => hostByTestID(renderer, 'save', 'Pressable').props.onPress());
    act(() => hostByTestID(renderer, 'remove', 'Pressable').props.onPress());
    act(() => renderer.root.findByProps({ testID: 'dialog-scrim' }).props.onPress());
    expect(save).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders the input member as a focused hairline field with dim placeholder copy', () => {
    const renderer = render(
      <HullDialogInput
        onChangeText={vi.fn()}
        placeholder="Room name"
        testID="room-name"
        value=""
      />,
    );
    const input = hostByTestID(renderer, 'room-name', 'TextInput');
    expect(input.props.placeholderTextColor).toBe(hull.textDisabled);
    const inputRule = renderer.root
      .findAllByType('View' as any)
      .find((node: any) => node.props.style?.borderBottomColor === hull.borderStrong)!;
    expect(inputRule.props.style).toMatchObject({
      borderBottomColor: hull.borderStrong,
      borderBottomWidth: 1,
    });
  });

  it('renders a bottom sheet with grip, metadata, destructive-only red, disabled state, and quiet cancel', () => {
    const onClose = vi.fn();
    const archive = vi.fn();
    const renderer = render(
      <HullActionSheetModal onClose={onClose} testID="sheet" title="Session" visible>
        <HullActionSheetRow
          label="Details"
          metadata="Current run"
          onPress={vi.fn()}
          testID="details"
        />
        <HullActionSheetRow
          destructive
          disabled
          label="Archive"
          onPress={archive}
          testID="archive"
        />
        <HullActionSheetCancel onPress={onClose} testID="cancel-sheet" />
      </HullActionSheetModal>,
    );

    const details = hostByTestID(renderer, 'details', 'Pressable');
    expect(details.props.accessibilityLabel).toBe('Details. Current run');
    const heading = renderer.root
      .findAllByProps({ accessibilityRole: 'header' })
      .find((node: any) => node.type === 'Text')!;
    expect(heading.children).toContain('Session');
    const archiveRow = hostByTestID(renderer, 'archive', 'Pressable');
    expect(archiveRow.props.accessibilityState).toEqual({ disabled: true, selected: false });
    expect(archiveRow.findByType('Text' as any).props.style).toContainEqual({
      color: hull.dialogDanger,
    });
    expect(
      renderer.root
        .findAllByType('View' as any)
        .some(
          (node: any) =>
            node.props.style?.height === 18 &&
            node.props.importantForAccessibility === 'no-hide-descendants',
        ),
    ).toBe(true);

    act(() => hostByTestID(renderer, 'cancel-sheet', 'Pressable').props.onPress());
    expect(onClose).toHaveBeenCalledOnce();
    expect(archive).not.toHaveBeenCalled();
  });

  it('keeps a mounted floating surface still across unrelated host renders', () => {
    modalRenderSpy.mockClear();
    surfaceRenderSpy.mockClear();
    const closedFrom = vi.fn();
    const pickedFrom = vi.fn();

    function LiveRoomHost({
      liveEventId,
      title = 'Attach',
    }: {
      liveEventId: string;
      title?: string;
    }) {
      return (
        <HullActionSheetModal
          onClose={() => closedFrom(liveEventId)}
          testID="live-sheet"
          title={title}
          visible
        >
          <HullActionSheetRow
            label="Photo"
            onPress={() => pickedFrom(liveEventId)}
            testID="live-sheet-photo"
          />
          <HullActionSheetRow label="Document" onPress={() => undefined} />
          <HullActionSheetCancel onPress={() => closedFrom(liveEventId)} />
        </HullActionSheetModal>
      );
    }

    const renderer = render(<LiveRoomHost liveEventId="agent-draft-1" />);
    for (let index = 2; index <= 25; index += 1) {
      act(() => renderer.update(<LiveRoomHost liveEventId={`agent-draft-${index}`} />));
    }

    expect(modalRenderSpy).toHaveBeenCalledTimes(1);
    expect(surfaceRenderSpy).toHaveBeenCalledTimes(1);
    act(() => hostByTestID(renderer, 'live-sheet-photo', 'Pressable').props.onPress());
    act(() => renderer.root.findByType('Modal' as any).props.onRequestClose());
    expect(pickedFrom).toHaveBeenLastCalledWith('agent-draft-25');
    expect(closedFrom).toHaveBeenLastCalledWith('agent-draft-25');

    act(() => renderer.update(<LiveRoomHost liveEventId="agent-draft-26" title="Attach files" />));
    expect(modalRenderSpy).toHaveBeenCalledTimes(2);
    expect(surfaceRenderSpy).toHaveBeenCalledTimes(2);
  });

  it('opens menu adapters as Hull sheets, closes before dispatch, and exposes a cancel row', () => {
    const choose = vi.fn();
    const renderer = render(
      <HullMenuTrigger
        accessibilityLabel="Machine"
        sections={[
          { key: 'machine', actions: [{ label: 'Mac', onPress: choose, selected: true }] },
        ]}
        testID="menu-trigger"
      >
        <TextForTest />
      </HullMenuTrigger>,
    );

    const trigger = hostByTestID(renderer, 'menu-trigger', 'Pressable');
    expect(trigger.props.accessibilityState).toEqual({ expanded: false });
    act(() => trigger.props.onPress());
    expect(renderer.root.findByType('Modal' as any).props.visible).toBe(true);

    const mac = renderer.root
      .findAllByProps({ accessibilityLabel: 'Mac' })
      .find((node: any) => node.type === 'Pressable')!;
    act(() => mac.props.onPress());
    expect(choose).toHaveBeenCalledOnce();
    expect(renderer.root.findByType('Modal' as any).props.visible).toBe(false);
  });
});

function TextForTest() {
  return React.createElement('TriggerCopy');
}
