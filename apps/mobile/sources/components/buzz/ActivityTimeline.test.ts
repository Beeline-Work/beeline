import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

vi.mock('./MonoHull', () => ({
  HullActivityTip: () => null,
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
    expect(narration.props.textStyle.fontSize).toBe(16);
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
