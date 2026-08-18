import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Modal: host('Modal'),
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

const mockInsets = vi.hoisted(() => ({ current: { top: 0, right: 0, bottom: 0, left: 0 } }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets.current,
}));

vi.mock('./MonoHull', () => ({
  HullActivityTip: () => null,
  // The two motion primitives are pure presentation over the same children, so
  // the stub keeps the children and the `live` flag (which the rail encodes as
  // a prop the structural assertions below read) and drops the animation.
  HullMechanismRail: (props: any) => ReactStub.createElement('HullMechanismRail', props),
  HullMechanismReveal: (props: any) =>
    ReactStub.createElement('HullMechanismReveal', props, props.children),
  HullSurface: (props: any) => ReactStub.createElement('HullSurface', props, props.children),
}));
vi.mock('./MonoMarkdown', () => ({
  MonoMarkdown: (props: any) =>
    ReactStub.createElement('MonoMarkdown', props, props.leadingInline ?? null, props.markdown),
}));

import * as ReactStub from 'react';

import { groknight } from '@/buzz/groknight';
import { ActivityTimeline } from './ActivityTimeline';

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

function renderedText(renderer: ReactTestRenderer): string {
  const strings: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      strings.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in (node as Record<string, unknown>)) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return strings.join(' ');
}

const NOISY_TURN = [
  {
    kind: 'output' as const,
    title: 'Output',
    text: 'Rewriting the callback so the retry state survives a reload.',
  },
  {
    kind: 'tool' as const,
    id: 'tool-1',
    title: 'execute',
    toolKind: 'execute',
    command: 'npm test -- --run',
    output: 'FAIL\n'.repeat(400),
    status: 'completed',
  },
  {
    kind: 'tool' as const,
    id: 'tool-2',
    title: 'edit',
    toolKind: 'edit',
    files: [{ path: 'sources/auth/oidc.ts', status: 'modified', diff: '+ retry()' }],
    status: 'completed',
  },
  { kind: 'tool' as const, id: 'read-1', title: 'read', toolKind: 'read' },
  { kind: 'tool' as const, id: 'read-2', title: 'read', toolKind: 'read' },
  { kind: 'tool' as const, id: 'search-1', title: 'search', toolKind: 'search' },
];

describe('corner narration', () => {
  it('renders the agent’s prose at the primary tier, on the slab', () => {
    const renderer = render(React.createElement(ActivityTimeline, { items: NOISY_TURN }));

    // The narration is on screen with nothing tapped: it is the spine of the
    // turn, not a footnote behind a disclosure.
    const narration = renderer.root.findByProps({ testID: 'activity-narration' });
    expect(narration.props.markdown).toContain('Rewriting the callback');
    // ...at the ledger's brightest tier and full width, exactly like an
    // ordinary agent turn — its transport must not change how it reads.
    expect(narration.props.textStyle.color).toBe(groknight.ledgerBright);
    expect(narration.props.textStyle.fontSize).toBe(14);
    expect(narration.props.textStyle.width).toBe('100%');
    expect(narration.props.textStyle.textShadowColor).toBe(groknight.ledgerGlow);
  });

  it('never puts narration behind the collapse', () => {
    const renderer = render(React.createElement(ActivityTimeline, { items: NOISY_TURN }));
    // Collapsed state — nothing opened — still shows every word of the prose.
    expect(renderedText(renderer)).toContain('Rewriting the callback');
    // (the review sheet is a Modal, so it is present but not visible)
    expect(renderer.root.findByType('Modal').props.visible).toBe(false);
  });

  it('renders a turn that is only prose, with no tool rows at all', () => {
    const renderer = render(
      React.createElement(ActivityTimeline, {
        items: [{ kind: 'output' as const, title: 'Output', text: 'I read the failing tests first.' }],
      }),
    );
    expect(renderedText(renderer)).toContain('I read the failing tests first.');
    expect(renderer.root.findAllByProps({ testID: 'activity-tool-note' })).toHaveLength(0);
  });
});

describe('corner tool activity', () => {
  it('folds every read-only call into one counted note', () => {
    const renderer = render(React.createElement(ActivityTimeline, { items: NOISY_TURN }));

    const note = renderer.root.findByProps({ testID: 'activity-tool-note' });
    // One note for all three observational calls — never one line per call,
    // and never a wall. Verb-counted, so it says what kind of work it was.
    expect(note.findAllByType('Text')[0].props.children.join('')).toContain(
      '3 TOOL CALLS · read 2, searched 1',
    );
    expect(note.findAllByType('Text')[0].props.numberOfLines).toBe(1);

    // The raw output of those calls is nowhere on the slab.
    const collapsed = renderedText(renderer);
    expect(collapsed).not.toContain('FAIL');
  });

  it('never goes silent through a turn that only ever looked at things', () => {
    // The research dead-air bug, from the client end. A batch of nothing but
    // reads and searches produces no mutation, no command, and so no mechanism
    // row — and before body tallied the calls it dropped, it produced no row
    // at all, leaving the corner blank through the exact stretch where the
    // agent was busiest. One counted line is the whole fix.
    const renderer = render(
      React.createElement(ActivityTimeline, {
        active: true,
        items: [
          {
            kind: 'summary' as const,
            title: 'Summary',
            text: '',
            rollup: { read: 8, searched: 3, listed: 1 },
          },
        ],
      }),
    );

    const note = renderer.root.findByProps({ testID: 'activity-tool-note' });
    // Live, so it says what it *is* doing, in the present tense grok uses for
    // a group still in flight.
    expect(note.findAllByType('Text')[0].props.children.join('')).toContain(
      '12 TOOL CALLS · reading 8, searching 3, listing 1',
    );
    // And the gold rail beside it is breathing, because the work is live.
    expect(renderer.root.findByType('HullMechanismRail').props.live).toBe(true);
  });

  it('demotes the same row to the past tense once the work settles', () => {
    const items = [
      { kind: 'summary' as const, title: 'Summary', text: '', rollup: { read: 8, searched: 3, listed: 1 } },
    ];
    const renderer = render(React.createElement(ActivityTimeline, { active: false, items }));

    const note = renderer.root.findByProps({ testID: 'activity-tool-note' });
    expect(note.findAllByType('Text')[0].props.children.join('')).toContain(
      '12 TOOL CALLS · read 8, searched 3, listed 1',
    );
    expect(renderer.root.findByType('HullMechanismRail').props.live).toBe(false);
  });

  it('shows a live signal even before a single call has been counted', () => {
    // The first batch has not landed yet. There is nothing to count and
    // nothing to name, but the corner must still not read as idle.
    const renderer = render(
      React.createElement(ActivityTimeline, {
        active: true,
        items: [{ kind: 'output' as const, title: 'Output', text: 'Looking into it.' }],
      }),
    );
    expect(renderer.root.findByType('HullMechanismRail').props.live).toBe(true);
  });

  it('reports the reasoning it can never show, as a bare elapsed receipt', () => {
    // grok's live `Thinking…` block collapses to `Thought for 5.8s` the
    // instant the answer lands. The block itself is unaffordable here — its
    // text never leaves the daemon — so the corner keeps only the collapse.
    const renderer = render(
      React.createElement(ActivityTimeline, {
        items: [
          { kind: 'summary' as const, title: 'Summary', text: '', rollup: { read: 2 }, thoughtMs: 5_800 },
        ],
      }),
    );
    expect(
      renderer.root.findByProps({ testID: 'activity-thought-receipt' }).props.children.join(''),
    ).toBe('· THOUGHT 5.8S');
  });

  it('still shows a turn whose only trace is the reasoning receipt', () => {
    // `hasContent` counts the receipt, so the row has to exist for it — an
    // older body that sends a span with no tally would otherwise render an
    // empty timeline rather than nothing or something.
    const renderer = render(
      React.createElement(ActivityTimeline, {
        items: [{ kind: 'summary' as const, title: 'Summary', text: '', thoughtMs: 2_400 }],
      }),
    );
    expect(
      renderer.root.findByProps({ testID: 'activity-thought-receipt' }).props.children.join(''),
    ).toBe('THOUGHT 2.4S');
  });

  it('gives a mutation and an executed command their own lines', () => {
    const renderer = render(React.createElement(ActivityTimeline, { items: NOISY_TURN }));

    // A file the agent changed keeps its own row and lifts a luminance step.
    const edit = renderer.root.findByProps({
      testID: 'activity-action-tool-2:file:sources/auth/oidc.ts',
    });
    expect(edit.findAllByType('Text')[0].props.children).toBe('▧');
    // ...and the command that ran keeps its own row too, distinct glyph.
    const command = renderer.root.findByProps({ testID: 'activity-action-tool-1' });
    expect(command.findAllByType('Text')[0].props.children).toBe('›_');

    // Both are visible with nothing tapped; neither is inside the note.
    const collapsed = renderedText(renderer);
    expect(collapsed).toContain('sources/auth/oidc.ts');
  });

  it('opens the counted note into a bottom-up review, newest call first', () => {
    const renderer = render(React.createElement(ActivityTimeline, { items: NOISY_TURN }));

    act(() => renderer.root.findByProps({ testID: 'activity-tool-note' }).props.onPress());
    expect(renderer.root.findByType('Modal').props.visible).toBe(true);

    const sheet = renderer.root.findByProps({ testID: 'activity-review-sheet' });
    const rows = sheet
      .findAll((node: any) => typeof node.props?.testID === 'string')
      .map((node: any) => node.props.testID as string)
      .filter((id: string) => id.startsWith('activity-review-action-'))
      // The RN mock renders each Pressable as a component wrapping a host node
      // of the same name, so every row is found twice.
      .filter((id: string, index: number, all: string[]) => all.indexOf(id) === index);
    // Newest first: the search ran last, so it is the first thing the reader
    // sees, and scrolling down walks backwards through the turn.
    expect(rows).toEqual([
      'activity-review-action-search-1',
      'activity-review-action-read-2',
      'activity-review-action-read-1',
    ]);
    // The header restates the thing that was tapped, so it is never lost.
    expect(renderedText(renderer)).toContain('3 TOOL CALLS');
  });

  it('reveals raw output only inside the review, never on the slab', () => {
    const renderer = render(React.createElement(ActivityTimeline, { items: NOISY_TURN }));
    expect(renderedText(renderer)).not.toContain('npm test');

    act(() => renderer.root.findByProps({ testID: 'activity-action-tool-1' }).props.onPress());
    expect(renderedText(renderer)).toContain('npm test');
  });

  it('shows the real per-call detail body ships for a folded call, not the empty placeholder', () => {
    // Before body carried an `observed` receipt on the summary event, the
    // client had nothing of its own to show here — every folded call was
    // dropped entirely, and the sheet fell back to "counted but carried no
    // detail of their own" no matter how many calls the note counted.
    const renderer = render(
      React.createElement(ActivityTimeline, {
        items: [
          {
            kind: 'summary' as const,
            title: 'Summary',
            text: '',
            rollup: { read: 1, ran: 1 },
            observed: [
              { verb: 'read', target: 'src/foo.ts', result: 'export function foo() {}' },
              { verb: 'ran', target: 'npm test -- --run', result: 'PASS 12 tests' },
            ],
          },
        ],
      }),
    );

    act(() => renderer.root.findByProps({ testID: 'activity-tool-note' }).props.onPress());
    const sheetText = renderedText(renderer);
    // A real row per counted call, naming what it looked at.
    expect(sheetText).toContain('Read src/foo.ts');
    expect(sheetText).toContain('Ran npm test -- --run');
    expect(sheetText).not.toContain('These calls were counted but carried no detail of their own.');

    // Tapping one drills into its own concise result, not raw multi-KB output.
    act(() => renderer.root.findByProps({ testID: 'activity-review-action-observed-0' }).props.onPress());
    expect(renderedText(renderer)).toContain('export function foo() {}');
  });

  it('gives the counted note no box of its own', () => {
    const renderer = render(React.createElement(ActivityTimeline, { items: NOISY_TURN }));
    const note = renderer.root.findByProps({ testID: 'activity-tool-note' });
    expect(note.props.style).not.toHaveProperty('borderWidth');
    expect(note.props.style).not.toHaveProperty('borderRadius');
    expect(note.props.style).not.toHaveProperty('backgroundColor');
  });

  it('renders nothing at all for a turn with no actions and no notes', () => {
    const renderer = render(React.createElement(ActivityTimeline, { items: [] }));
    expect(renderer.toJSON()).toBeNull();
  });
});

describe('review sheet safe area', () => {
  afterEach(() => {
    mockInsets.current = { top: 0, right: 0, bottom: 0, left: 0 };
  });

  // The sheet's root style is the only array-valued `style` prop in this tree
  // (`[styles.reviewRoot, { paddingBottom }]`) — everything else is a plain
  // object — so merging every array-styled View and reading `paddingBottom`
  // finds it without depending on tree position.
  function reviewRootPaddingBottom(renderer: ReactTestRenderer): number | undefined {
    const merged = renderer.root
      .findAllByType('View')
      .map((node: any) => node.props.style)
      .filter((style: unknown): style is unknown[] => Array.isArray(style))
      .map((style: unknown[]) => Object.assign({}, ...style))
      .find((style: any) => 'paddingBottom' in style);
    return merged?.paddingBottom;
  }

  it('clears the Android system nav bar by padding the sheet with the device inset', () => {
    mockInsets.current = { top: 0, right: 0, bottom: 34, left: 0 };
    const renderer = render(React.createElement(ActivityTimeline, { items: NOISY_TURN }));
    act(() => renderer.root.findByProps({ testID: 'activity-tool-note' }).props.onPress());
    expect(reviewRootPaddingBottom(renderer)).toBe(34);
  });

  it('keeps a fixed floor on a device with no gesture nav bar', () => {
    mockInsets.current = { top: 0, right: 0, bottom: 0, left: 0 };
    const renderer = render(React.createElement(ActivityTimeline, { items: NOISY_TURN }));
    act(() => renderer.root.findByProps({ testID: 'activity-tool-note' }).props.onPress());
    expect(reviewRootPaddingBottom(renderer)).toBe(12);
  });
});
