import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('./MonoHull', () => ({
  PixelLoader: (props: any) => React.createElement('PixelLoader', props),
}));
vi.mock('./MonoMarkdown', () => ({
  MonoMarkdown: (props: any) => React.createElement('MonoMarkdown', props, props.markdown),
}));

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

const TOOLS = [
  {
    kind: 'tool' as const,
    id: 'read',
    title: 'read',
    toolKind: 'read',
    input: 'sources/gateway.ts',
    status: 'completed',
  },
  {
    kind: 'tool' as const,
    id: 'failure',
    title: 'certification gate',
    toolKind: 'execute',
    command: 'pnpm fast-gate',
    output: 'sh: 1: pnpm: not found',
    status: 'failed',
  },
];

describe('live streaming turn', () => {
  it('renders nothing after finalization, even when machine items remain in memory', () => {
    expect(render(<ActivityTimeline active={false} items={TOOLS} />).toJSON()).toBeNull();
  });

  it('renders one non-interactive row per tool and the accumulating conversational draft', () => {
    const renderer = render(
      <ActivityTimeline
        active
        handle="Clara"
        items={TOOLS}
        messageDraft="The answer is arriving."
        stamp="now"
      />,
    );
    expect(renderer.root.findByProps({ testID: 'activity-message-draft' }).props.markdown).toBe(
      'The answer is arriving.',
    );
    expect(
      new Set(
        renderer.root
          .findAll((node: { props: { testID?: string } }) =>
            /^activity-step-(read|failure)$/.test(node.props.testID ?? ''),
          )
          .map((node: { props: { testID?: string } }) => node.props.testID),
      ),
    ).toEqual(new Set(['activity-step-read', 'activity-step-failure']));
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
  });

  it('routes streamed prose through the Room-style Markdown renderer', () => {
    const renderer = render(
      <ActivityTimeline
        active
        items={[
          {
            kind: 'thinking',
            title: 'Thinking',
            text: '**PRIVATE REASONING MUST NOT RENDER**',
          },
        ]}
        messageDraft="**The reply is ready**"
      />,
    );

    expect(
      renderer.root
        .findAllByType('MonoMarkdown')
        .map((node: { props: { markdown: string; testID?: string } }) => ({
          markdown: node.props.markdown,
          testID: node.props.testID,
        })),
    ).toEqual([{ markdown: '**The reply is ready**', testID: 'activity-message-draft' }]);
  });

  it('never renders tool results, diffs, or thought text in the transcript', () => {
    const renderer = render(
      <ActivityTimeline
        active
        items={[
          {
            kind: 'thinking',
            title: 'Thinking',
            text: 'PRIVATE THOUGHT SENTINEL',
          },
          {
            kind: 'tool',
            id: 'edit',
            title: 'Edit files',
            toolKind: 'edit',
            status: 'completed',
            output: 'RAW TOOL RESULT SENTINEL',
            files: [{ path: 'apps/mobile/Ledger.tsx', diff: 'INLINE DIFF SENTINEL' }],
          },
          {
            kind: 'tool',
            id: 'execute',
            title: 'Tool',
            toolKind: 'execute',
            command: 'RAW COMMAND SENTINEL --print-everything',
            status: 'completed',
          },
          {
            kind: 'summary',
            title: 'read receipts',
            observed: [{ verb: 'read', target: 'Ledger.tsx', result: 'OBSERVED RESULT SENTINEL' }],
          },
        ]}
        messageDraft="Conversational answer"
      />,
    );

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Conversational answer');
    expect(rendered).not.toContain('PRIVATE THOUGHT SENTINEL');
    expect(rendered).not.toContain('RAW TOOL RESULT SENTINEL');
    expect(rendered).not.toContain('RAW COMMAND SENTINEL');
    expect(rendered).not.toContain('INLINE DIFF SENTINEL');
    expect(rendered).not.toContain('OBSERVED RESULT SENTINEL');
    expect(
      renderer.root.findAll((node: { props: { testID?: string } }) =>
        node.props.testID?.startsWith('activity-result-'),
      ),
    ).toHaveLength(0);
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
  });

  it('keeps the terse failure verdict in the one-line mechanism row', () => {
    const renderer = render(<ActivityTimeline active items={TOOLS} />);
    const verdict = renderer.root.findByProps({ testID: 'activity-verdict-failure' });
    expect(verdict.props.children).toBe('×');
    expect(verdict.props.style).toContainEqual(
      expect.objectContaining({ color: groknight.accent }),
    );
  });
});
