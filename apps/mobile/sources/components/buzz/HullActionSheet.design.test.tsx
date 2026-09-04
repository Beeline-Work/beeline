import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The sheet row's trailing column is a CLOSED vocabulary on ONE axis
 * (captain report C102). Five rows once carried a pencil, an empty square, a
 * filled circle, a clock and a red square — two of which read as unticked
 * checkboxes and were not — each inside its own framed slab. This pins what
 * replaced them: a value, a switch, a chevron, or nothing at all, every form
 * ending on the sheet's own trailing inset, and no row wearing a box.
 */
const theme = vi.hoisted(() => ({
  hull: {
    accent: '#b08a4a',
    bgPressed: '#2a1b31',
    bgRaised: '#1d1024',
    border: '#39273f',
    chrome: '#f1edf2',
    dialogDanger: '#c4544d',
    proseRegular: 'GrokRegular',
    proseSemibold: 'GrokSemibold',
    radius: 3,
    space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
    textDisabled: '#75687a',
    textMuted: '#83838d',
    textPrimary: '#f1edf2',
    textSecondary: '#aaa0ae',
    type: {
      body: { fontFamily: 'GrokRegular', fontSize: 16, lineHeight: 23, letterSpacing: 0 },
      bodyStrong: { fontFamily: 'GrokSemibold', fontSize: 16, lineHeight: 23, letterSpacing: 0 },
      hero: { fontFamily: 'GrokMedium', fontSize: 22, lineHeight: 32, letterSpacing: -0.3 },
      meta: { fontFamily: 'GrokRegular', fontSize: 13, lineHeight: 19, letterSpacing: 0 },
    },
  },
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Modal: host('Modal'),
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    Switch: host('Switch'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    absoluteFill: { position: 'absolute', inset: 0 },
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

vi.mock('./HullDialog', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { HullFloatingSurface: host('HullFloatingSurface'), HullModal: host('HullModal') };
});

import { HULL_SHEET_INSET, HullActionSheetRow } from './HullActionSheet';

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

function rowStyle(renderer: ReactTestRenderer, testID: string): Record<string, unknown> {
  const node = renderer.root
    .findAll((candidate: any) => candidate.props?.testID === testID)
    .find((candidate: any) => candidate.type === 'Pressable' || candidate.type === 'View')!;
  const raw = node.props.style;
  const resolved = typeof raw === 'function' ? raw({ pressed: false }) : raw;
  return Object.assign({}, ...[resolved].flat(Infinity).filter(Boolean));
}

function texts(renderer: ReactTestRenderer, testID: string): string[] {
  const node = renderer.root
    .findAll((candidate: any) => candidate.props?.testID === testID)
    .find((candidate: any) => candidate.type === 'Pressable' || candidate.type === 'View')!;
  return node
    .findAllByType('Text' as any)
    .map((text: any) => text.props.children)
    .filter((child: unknown) => typeof child === 'string');
}

function switches(renderer: ReactTestRenderer): unknown[] {
  return renderer.root.findAllByType('Switch' as any);
}

describe('sheet row trailing vocabulary (C102)', () => {
  it('gives a setting its value, a toggle its switch, an opener its chevron, and an action nothing', () => {
    const renderer = render(
      <>
        <HullActionSheetRow label="Repo" metadata="Beeline-Work/beeline" testID="value-row" />
        <HullActionSheetRow
          label="Repo notifications"
          onPress={() => undefined}
          testID="toggle-row"
          toggle={{ onValueChange: () => undefined, value: true }}
        />
        <HullActionSheetRow
          chevron="right"
          label="Scheduled work"
          onPress={() => undefined}
          testID="chevron-row"
        />
        <HullActionSheetRow
          destructive
          label="Delete Room"
          onPress={() => undefined}
          testID="action-row"
        />
      </>,
    );

    // A value stands alone; it never brings a mark of its own.
    expect(texts(renderer, 'value-row')).toEqual(['Repo', 'Beeline-Work/beeline']);
    // A toggle is the switch, and carries no written On/Off beside it.
    expect(texts(renderer, 'toggle-row')).toEqual(['Repo notifications']);
    expect(switches(renderer)).toHaveLength(1);
    // An opener is the chevron; open-here is the same mark turned down.
    expect(texts(renderer, 'chevron-row')).toEqual(['Scheduled work', '›']);
    // A plain action acts on press and shows nothing at all.
    expect(texts(renderer, 'action-row')).toEqual(['Delete Room']);
  });

  it('turns the same chevron down while what it opens stands beneath it', () => {
    const renderer = render(
      <HullActionSheetRow chevron="down" label="Repo" onPress={() => undefined} testID="open" />,
    );
    expect(texts(renderer, 'open')).toEqual(['Repo', '⌄']);
  });

  it('ends every trailing form on ONE axis: the sheet row inset', () => {
    const renderer = render(
      <HullActionSheetRow
        chevron="right"
        label="Repo"
        metadata="Beeline-Work/beeline"
        onPress={() => undefined}
        testID="axis"
      />,
    );
    const row = rowStyle(renderer, 'axis');
    expect(row.paddingHorizontal).toBe(HULL_SHEET_INSET);
    const trailing = renderer.root
      .findAllByType('Text' as any)
      .filter((text: any) => typeof text.props.children === 'string')
      .filter((text: any) => text.props.children !== 'Repo')
      .map((text: any) => Object.assign({}, ...[text.props.style].flat(Infinity).filter(Boolean)));
    expect(trailing).toHaveLength(2);
    // Both the value and the chevron are right-aligned in their own box, so
    // each one's trailing EDGE lands on the row's padding edge (C99's fix on
    // the Members page, now the rule for every sheet row).
    for (const style of trailing) expect(style.textAlign).toBe('right');
  });

  it('renders a list, never a stack of framed slabs', () => {
    const renderer = render(
      <HullActionSheetRow label="Rename" onPress={() => undefined} testID="plain" />,
    );
    const row = rowStyle(renderer, 'plain');
    // A repeating unit gets whitespace and one hairline; a box is reserved for
    // something the reader must find and act on (DESIGN.md → Shape).
    expect(row.borderWidth).toBeUndefined();
    expect(row.borderRadius).toBeUndefined();
    expect(row.backgroundColor).toBeUndefined();
    expect(row.borderTopWidth).toBe(1);
    expect(row.borderTopColor).toBe(theme.hull.border);
  });

  it('keeps a value and a description out of the label, and the destructive tone on it', () => {
    const renderer = render(
      <HullActionSheetRow
        description="Permanently remove this Room."
        destructive
        label="Delete Room"
        metadata="4 members"
        onPress={() => undefined}
        testID="danger"
      />,
    );
    const [label, description, value] = texts(renderer, 'danger');
    expect(label).toBe('Delete Room');
    expect(description).toBe('Permanently remove this Room.');
    expect(value).toBe('4 members');
    const labelNode = renderer.root
      .findAllByType('Text' as any)
      .find((text: any) => text.props.children === 'Delete Room')!;
    expect(Object.assign({}, ...[labelNode.props.style].flat(Infinity).filter(Boolean)).color).toBe(
      theme.hull.dialogDanger,
    );
  });

  it('announces a toggle row once, as one switch carrying its own state', () => {
    const renderer = render(
      <HullActionSheetRow
        label="Repo notifications"
        onPress={() => undefined}
        testID="toggle"
        toggle={{ onValueChange: () => undefined, value: false }}
      />,
    );
    const row = renderer.root
      .findAll((node: any) => node.props?.testID === 'toggle')
      .find((node: any) => node.type === 'Pressable')!;
    expect(row.props.accessibilityRole).toBe('switch');
    expect(row.props.accessibilityState).toEqual({ checked: false, disabled: false });
    // The control inside it is hidden, or a reader meets the same row twice.
    const shell = renderer.root
      .findAllByType('View' as any)
      .find((node: any) => node.findAllByType('Switch' as any).length === 1)!;
    expect(shell.props.accessibilityElementsHidden).toBe(true);
    expect(shell.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('keeps every row tappable and on the three-tone ladder', () => {
    const renderer = render(
      <HullActionSheetRow
        description="Change its display name."
        label="Rename"
        metadata="beeline"
        onPress={() => undefined}
        testID="tones"
      />,
    );
    // A row is a control before it is a line of type.
    expect(rowStyle(renderer, 'tones').minHeight as number).toBeGreaterThanOrEqual(44);
    const tone = (children: string) =>
      Object.assign(
        {},
        ...[
          renderer.root
            .findAllByType('Text' as any)
            .find((text: any) => text.props.children === children)!.props.style,
        ]
          .flat(Infinity)
          .filter(Boolean),
      ).color;
    expect(tone('Rename')).toBe(theme.hull.textPrimary);
    expect(tone('Change its display name.')).toBe(theme.hull.textMuted);
    expect(tone('beeline')).toBe(theme.hull.textMuted);
  });

  it('reads a factual row flat: no press, no button role', () => {
    const renderer = render(<HullActionSheetRow label="Repo" metadata="None" testID="readonly" />);
    const hosts = renderer.root
      .findAll((node: any) => node.props?.testID === 'readonly')
      .filter((node: any) => typeof node.type === 'string')
      .map((node: any) => node.type);
    expect(hosts).toEqual(['View']);
    expect(
      renderer.root.findAll((node: any) => node.props?.accessibilityRole === 'button'),
    ).toHaveLength(0);
  });
});
