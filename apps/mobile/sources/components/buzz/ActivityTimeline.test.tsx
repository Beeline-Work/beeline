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
    StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

const mockInsets = vi.hoisted(() => ({ current: { top: 0, right: 0, bottom: 0, left: 0 } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => mockInsets.current }));
vi.mock('./MonoHull', () => ({
  PixelLoader: (props: any) => ReactStub.createElement('PixelLoader', props),
}));
vi.mock('./MonoMarkdown', () => ({
  MonoMarkdown: (props: any) => ReactStub.createElement('MonoMarkdown', props, props.markdown),
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
    if (typeof node === 'string') return void strings.push(node);
    if (Array.isArray(node)) return void node.forEach(walk);
    if (node && typeof node === 'object' && 'children' in (node as Record<string, unknown>)) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return strings.join(' ');
}

const MIXED_RUN = [
  { kind: 'output' as const, title: 'Output', text: 'The ledger keeps the narrative in front.' },
  {
    kind: 'tool' as const,
    id: 'typecheck',
    title: 'execute',
    toolKind: 'execute',
    command: 'npm run typecheck',
    output: 'Typecheck passed',
    status: 'completed',
  },
  {
    kind: 'tool' as const,
    id: 'edit',
    title: 'edit',
    toolKind: 'edit',
    files: [{ path: 'sources/gateway.ts', status: 'modified', diff: '+ ledger' }],
    status: 'completed',
  },
  {
    kind: 'tool' as const,
    id: 'read',
    title: 'read',
    toolKind: 'read',
    input: 'sources/gateway.ts',
    output: 'export const gateway = true;',
    status: 'completed',
  },
  {
    kind: 'tool' as const,
    id: 'failure',
    title: 'fast gate',
    toolKind: 'execute',
    command: 'pnpm fast-gate',
    output:
      '\u001b[31mERR_PNPM_RECURSIVE_RUN_FIRST_FAIL\u001b[0m\nsh: 1: pnpm: not found\n ELIFECYCLE Command failed',
    status: 'failed',
  },
  {
    kind: 'summary' as const,
    title: 'Summary',
    text: 'Compared both render paths.',
    thoughtMs: 51_000,
  },
];

describe('tool ledger transcript', () => {
  it('leaves agent prose untouched and primary', () => {
    const renderer = render(<ActivityTimeline items={MIXED_RUN} />);
    const narration = renderer.root.findByProps({ testID: 'activity-narration' });
    expect(narration.props.markdown).toContain('narrative in front');
    expect(narration.props.textStyle.color).toBe(groknight.ledgerBright);
    expect(narration.props.textStyle.fontSize).toBe(16);
  });

  it('collapses every machine run into one attributed, stamped line by default', () => {
    const renderer = render(<ActivityTimeline handle="Clara" items={MIXED_RUN} stamp="15:41" />);
    const group = renderer.root.findByProps({ testID: 'activity-step-group' });
    expect(group.props.accessibilityState).toEqual({ expanded: false });
    const text = renderedText(renderer);
    expect(text).toContain('CLARA');
    expect(text).toContain('read');
    expect(text).toContain('thought 51s');
    expect(text).toContain('15:41');
    expect(text).not.toContain('TOOL CALL');
    expect(text).not.toContain('5 steps');
    expect(
      renderer.root.findAll((node: any) =>
        /^activity-step-(?!group)/.test(node.props?.testID ?? ''),
      ),
    ).toHaveLength(0);
  });

  it('expands a group in place into one line per step', () => {
    const renderer = render(<ActivityTimeline items={MIXED_RUN} />);
    act(() => renderer.root.findByProps({ testID: 'activity-step-group' }).props.onPress());
    expect(
      renderer.root.findByProps({ testID: 'activity-step-group' }).props.accessibilityState,
    ).toEqual({ expanded: true });
    for (const id of ['typecheck', 'edit', 'read', 'failure', 'thought-0']) {
      expect(renderer.root.findByProps({ testID: `activity-step-${id}` })).toBeTruthy();
    }
  });

  it('collapses runs of three or fewer, including thought-only groups', () => {
    const renderer = render(<ActivityTimeline items={MIXED_RUN.slice(1, 4)} />);
    expect(renderer.root.findByProps({ testID: 'activity-step-group' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ testID: 'activity-step-typecheck' })).toHaveLength(0);

    const thought = render(<ActivityTimeline items={[MIXED_RUN[5]]} />);
    expect(thought.root.findByProps({ testID: 'activity-step-group' })).toBeTruthy();
    expect(renderedText(thought)).toContain('thought 51s');
  });

  it('uses one 44pt hairline row with an outcome-aware accessibility label', () => {
    const renderer = render(<ActivityTimeline items={MIXED_RUN.slice(1, 3)} />);
    act(() => renderer.root.findByProps({ testID: 'activity-step-group' }).props.onPress());
    const row = renderer.root.findByProps({ testID: 'activity-step-typecheck' });
    expect(row.props.style({ pressed: false })[0]).toMatchObject({
      minHeight: 44,
      borderBottomWidth: 1,
    });
    expect(row.props.accessibilityLabel).toBe('type checks, succeeded');
  });

  it('puts the distilled failure token inline with a brass cross and no FAILED chip', () => {
    const renderer = render(<ActivityTimeline items={[MIXED_RUN[4]]} />);
    act(() => renderer.root.findByProps({ testID: 'activity-step-group' }).props.onPress());
    expect(renderer.root.findByProps({ testID: 'activity-reason-failure' }).props.children).toBe(
      'command not found: pnpm',
    );
    const verdict = renderer.root.findByProps({ testID: 'activity-verdict-failure' });
    expect(verdict.props.children).toBe('×');
    expect(verdict.props.style[1].color).toBe(groknight.accent);
    expect(renderedText(renderer)).not.toContain('FAILED');
    expect(renderedText(renderer)).not.toContain('ELIFECYCLE');
  });

  it('renders thoughts as the same quiet line with a tabular duration', () => {
    const renderer = render(<ActivityTimeline items={[MIXED_RUN[5]]} />);
    act(() => renderer.root.findByProps({ testID: 'activity-step-group' }).props.onPress());
    const row = renderer.root.findByProps({ testID: 'activity-step-thought-0' });
    expect(row.props.accessibilityLabel).toBe('thought, succeeded');
    expect(renderedText(renderer)).toContain('thought');
    expect(renderedText(renderer)).toContain('51s');
  });

  it('uses the existing spinner treatment for a running line', () => {
    const renderer = render(
      <ActivityTimeline
        active
        items={[
          {
            kind: 'tool',
            id: 'live',
            title: 'execute',
            toolKind: 'execute',
            command: 'npm test',
            status: 'in_progress',
          },
        ]}
      />,
    );
    act(() => renderer.root.findByProps({ testID: 'activity-step-group' }).props.onPress());
    expect(
      renderer.root.findByProps({ testID: 'activity-verdict-live' }).findByType('PixelLoader'),
    ).toBeTruthy();
  });

  it('opens full selectable raw output in the flat sheet and closes on dismiss', () => {
    const renderer = render(<ActivityTimeline items={MIXED_RUN.slice(1, 3)} />);
    act(() => renderer.root.findByProps({ testID: 'activity-step-group' }).props.onPress());
    expect(renderer.root.findByType('Modal').props.visible).toBe(false);
    act(() => renderer.root.findByProps({ testID: 'activity-step-typecheck' }).props.onPress());
    expect(renderer.root.findByType('Modal').props.visible).toBe(true);
    expect(renderer.root.findByProps({ testID: 'activity-raw-output-sheet' })).toBeTruthy();
    const raw = renderer.root.findAll((node: any) => node.props?.selectable === true)[0];
    expect(raw.props.children).toContain('Typecheck passed');
    act(() => renderer.root.findByType('Modal').props.onRequestClose());
    expect(renderer.root.findByType('Modal').props.visible).toBe(false);
  });

  it('renders nothing for a plan-only or empty activity event', () => {
    expect(render(<ActivityTimeline items={[]} />).toJSON()).toBeNull();
  });
});

describe('raw output sheet safe area', () => {
  afterEach(() => {
    mockInsets.current = { top: 0, right: 0, bottom: 0, left: 0 };
  });

  function sheetRootPaddingBottom(renderer: ReactTestRenderer): number | undefined {
    return renderer.root
      .findAllByType('View')
      .map((node: any) => node.props.style)
      .filter(Array.isArray)
      .map((style: unknown[]) => Object.assign({}, ...style))
      .find((style: any) => 'paddingBottom' in style)?.paddingBottom;
  }

  it('clears the Android system nav bar', () => {
    mockInsets.current = { top: 0, right: 0, bottom: 34, left: 0 };
    const renderer = render(<ActivityTimeline items={MIXED_RUN.slice(1, 3)} />);
    act(() => renderer.root.findByProps({ testID: 'activity-step-group' }).props.onPress());
    act(() => renderer.root.findByProps({ testID: 'activity-step-typecheck' }).props.onPress());
    expect(sheetRootPaddingBottom(renderer)).toBe(34);
  });

  it('keeps a 12pt floor without an inset', () => {
    const renderer = render(<ActivityTimeline items={MIXED_RUN.slice(1, 3)} />);
    act(() => renderer.root.findByProps({ testID: 'activity-step-group' }).props.onPress());
    act(() => renderer.root.findByProps({ testID: 'activity-step-typecheck' }).props.onPress());
    expect(sheetRootPaddingBottom(renderer)).toBe(12);
  });
});
