/**
 * The member picker as the app actually mounts it: the REAL sheet, the real
 * `HullModal` presentation boundary, the real `HullActionSheet`, the real
 * `IdentityMark` and the real creature drawings — and, crucially, styles and a
 * `Pressable` shaped the way the Unistyles babel plugin shapes them in a
 * release bundle.
 *
 * `MemberPickerSheet.test.tsx` beside this file mocks all of that away to
 * assert the picker's own wiring, which is why it stayed green while opening
 * the picker on a device threw `undefined is not a function` into the route's
 * error boundary. Two production facts have to be in the test for that crash
 * to exist at all:
 *
 *  - `react-native-unistyles/plugin` rewrites `Pressable` (and every other RN
 *    primitive) to the Unistyles wrapper. That wrapper reads the C++ handle off
 *    a non-function `style` by calling `style[unistyles_<hash>].uni__getStyles()`.
 *    Vitest never runs that babel plugin, so no other test here renders it.
 *  - a Unistyles style carries that handle in a `unistyles_<hash>` property
 *    whose own members are all defined `enumerable: false`
 *    (`cxx/common/Helpers.h → defineHiddenProperty`).
 *
 * `HullModal` rebuilds every plain object in its subtree's props, so a rebuild
 * that reads only enumerable keys silently empties that handle.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { unistylesTheme } = vi.hoisted(() => ({ unistylesTheme: {} as { buzz?: any } }));

vi.mock('react-native-unistyles', async () => {
  const { beelineThemes } = await import('@/buzz/groknight');
  const theme = { buzz: beelineThemes.obsidian };
  unistylesTheme.buzz = theme.buzz;
  let counter = 0;
  /**
   * A style the way Unistyles hands one back: the parsed properties, plus one
   * enumerable `unistyles_<hash>` key holding a secrets object whose members —
   * `uni__getStyles` among them — are hidden from `Object.keys`.
   */
  const withSecrets = (style: Record<string, unknown>, index: number) => {
    const secrets = {};
    Object.defineProperty(secrets, 'uni__getStyles', {
      value: () => ({ ...style }),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(style, `unistyles_${index}`, {
      value: secrets,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return style;
  };
  return {
    StyleSheet: {
      hairlineWidth: 1,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
      create: (definition: unknown) => {
        const sheet = (
          typeof definition === 'function'
            ? (definition as (value: typeof theme) => Record<string, Record<string, unknown>>)(
                theme,
              )
            : definition
        ) as Record<string, Record<string, unknown>>;
        for (const key of Object.keys(sheet)) {
          const style = sheet[key];
          if (style && typeof style === 'object') withSecrets(style, (counter += 1));
        }
        return sheet;
      },
    },
    useUnistyles: () => ({ theme }),
  };
});

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  // `react-native-unistyles/src/components/native/Pressable.native.tsx`,
  // verbatim in the part that matters: a `style` that is not a function is read
  // for its C++ handle before it ever reaches the native view.
  const getStyles = (styleProps: Record<string, any> = {}) => {
    const unistyleKey = Object.keys(styleProps).find((key) => key.startsWith('unistyles_'));
    if (!unistyleKey) return styleProps;
    return { ...styleProps[unistyleKey].uni__getStyles(), [unistyleKey]: styleProps[unistyleKey] };
  };
  const UnistylesPressable = ({ style, children, ...rest }: any) =>
    ReactModule.createElement(
      'Pressable',
      {
        ...rest,
        style: typeof style === 'function' ? style({ pressed: false }) : getStyles(style),
      },
      children,
    );
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Image: host('Image'),
    Modal: host('Modal'),
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: UnistylesPressable,
    ScrollView: host('ScrollView'),
    StyleSheet: {
      create: (styles: unknown) => styles,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
      hairlineWidth: 1,
    },
    Switch: host('Switch'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    default: host('Svg'),
    Circle: host('Circle'),
    Ellipse: host('Ellipse'),
    G: host('G'),
    Line: host('Line'),
    Path: host('Path'),
    Polygon: host('Polygon'),
    Rect: host('Rect'),
  };
});
vi.mock('react-native-keyboard-controller', async () => {
  const ReactModule = await import('react');
  return {
    KeyboardAvoidingView: (props: any) =>
      ReactModule.createElement('KeyboardAvoidingView', props, props.children),
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-haptics', () => ({
  impactAsync: () => undefined,
  notificationAsync: () => undefined,
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      View: (props: any) => ReactModule.createElement('AnimatedView', props, props.children),
    },
    Easing: { linear: 'linear', out: (fn: unknown) => fn, poly: (n: number) => n },
    FadeInDown: { duration: () => ({ easing: () => ({}) }) },
    ReduceMotion: { System: 'system' },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => false,
    useSharedValue: (value: number) => ({ value }),
    withRepeat: (value: unknown) => value,
    withSequence: (value: unknown) => value,
    withTiming: (value: number) => value,
  };
});

import { MemberPickerSheet, type MemberPickerCandidate } from './MemberPickerSheet';

const ANA = 'a'.repeat(64);
const OX = 'b'.repeat(64);

/** One real candidate of each kind, shaped exactly as the Room screen's
 *  `participantPickerCandidates` builds them (`[channelId].tsx`). */
const CANDIDATES: MemberPickerCandidate[] = [
  { pubkey: ANA, name: 'Ana', handle: 'ana', kind: 'person', face: 'fox' },
  { pubkey: OX, name: 'Oxide', handle: 'oxide', kind: 'agent', face: 'stag' },
];

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

function baseProps(kind: 'person' | 'agent' | null) {
  return {
    visible: true,
    onClose: vi.fn(),
    candidates: CANDIDATES,
    kind,
    workspacePeerCount: 2,
    canManage: true,
    busy: false,
    error: null,
    onAdd: vi.fn(),
    onInvitePerson: vi.fn(),
    onConnectAgent: vi.fn(),
  };
}

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

function hostWithTestID(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    (node: any) => typeof node.type === 'string' && node.props?.testID === testID,
    { deep: true },
  );
}

describe('MemberPickerSheet, mounted the way a Room mounts it', () => {
  it('draws the person row through the real modal, sheet and creature plate', () => {
    const renderer = render(<MemberPickerSheet {...baseProps('person')} />);

    expect(hostWithTestID(renderer, `member-picker-candidate-${ANA}`)).toHaveLength(1);
    expect(hostWithTestID(renderer, 'identity-face-plate')).toHaveLength(1);
  });

  it('draws the agent row through the real modal, sheet and creature plate', () => {
    const renderer = render(<MemberPickerSheet {...baseProps('agent')} />);

    expect(hostWithTestID(renderer, `member-picker-candidate-${OX}`)).toHaveLength(1);
    expect(hostWithTestID(renderer, 'identity-face-plate')).toHaveLength(1);
  });

  it('draws both kinds at once, and the two Workspace-level ways in beneath them', () => {
    const renderer = render(<MemberPickerSheet {...baseProps(null)} />);

    expect(hostWithTestID(renderer, `member-picker-candidate-${ANA}`)).toHaveLength(1);
    expect(hostWithTestID(renderer, `member-picker-candidate-${OX}`)).toHaveLength(1);
    expect(hostWithTestID(renderer, 'room-member-picker-invite-person')).toHaveLength(1);
    expect(hostWithTestID(renderer, 'room-member-picker-add-agent')).toHaveLength(1);
  });

  it('survives the Room’s own open sequence: closed, then open and loading, then the roster lands', () => {
    const props = baseProps('person');
    const renderer = render(<MemberPickerSheet {...props} visible={false} candidates={null} />);
    act(() => renderer.update(<MemberPickerSheet {...props} visible candidates={null} />));
    expect(hostWithTestID(renderer, 'member-picker-loading')).toHaveLength(1);
    act(() => renderer.update(<MemberPickerSheet {...props} visible />));

    expect(hostWithTestID(renderer, `member-picker-candidate-${ANA}`)).toHaveLength(1);
  });

  it('keeps a candidate row’s Unistyles handle intact across the modal boundary', () => {
    // The crash itself, at the seam: the row's style crosses `HullModal`'s
    // presentation reconciler on its way to the Unistyles `Pressable`, which
    // calls the handle hidden inside it. Before the fix this render threw
    // `undefined is not a function` — the captain's full-screen failure.
    const renderer = render(<MemberPickerSheet {...baseProps(null)} />);
    const row = hostWithTestID(renderer, `member-picker-candidate-${ANA}`)[0]!;

    // `getStyles` spread the resolved style in, so the row really wears it.
    expect(row.props.style.minHeight).toBe(unistylesTheme.buzz.layout.row);
  });

  it('checks a candidate and offers the brass add button', () => {
    const props = baseProps(null);
    const renderer = render(<MemberPickerSheet {...props} />);

    act(() => hostWithTestID(renderer, `member-picker-candidate-${OX}`)[0]!.props.onPress());
    const add = hostWithTestID(renderer, 'member-picker-add');
    expect(add).toHaveLength(1);
    act(() => add[0]!.props.onPress());
    expect(props.onAdd).toHaveBeenCalledWith([OX]);
  });
});

describe('MemberPickerSheet, across the shapes a Room actually hands it', () => {
  const shapes: Array<[string, Record<string, unknown>]> = [
    [
      'no face on record',
      {
        candidates: [
          { pubkey: ANA, name: 'Ana', handle: 'ana', kind: 'person' },
          { pubkey: OX, name: 'Oxide', handle: 'oxide', kind: 'agent' },
        ],
      },
    ],
    [
      'an unknown face id',
      { candidates: [{ pubkey: ANA, name: 'Ana', handle: 'ana', kind: 'person', face: 'wombat' }] },
    ],
    [
      'an avatar url',
      {
        candidates: [
          {
            pubkey: OX,
            name: 'Oxide',
            handle: 'oxide',
            kind: 'agent',
            avatarUrl: 'https://example.invalid/a.png',
          },
        ],
      },
    ],
    ['an empty roster', { candidates: [], workspacePeerCount: 0 }],
    ['a full Room', { candidates: [], workspacePeerCount: 4 }],
    ['a viewer who cannot manage', { canManage: false }],
    ['an add in flight', { busy: true }],
    ['an inline failure', { error: 'Could not add @Ana: boom' }],
    [
      'the pairing command',
      { pairCommand: 'npx usebeeline connect ABC-123', onCopyPairCommand: () => undefined },
    ],
    ['no Room in scope', { candidates: undefined, kind: undefined, workspacePeerCount: undefined }],
  ];
  for (const [name, overrides] of shapes) {
    it(`renders with ${name}`, () => {
      expect(() =>
        render(<MemberPickerSheet {...baseProps(null)} {...(overrides as any)} />),
      ).not.toThrow();
    });
  }
});
