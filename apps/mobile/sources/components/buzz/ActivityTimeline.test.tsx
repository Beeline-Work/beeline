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

  it('renders rolling thought, one non-interactive row per tool, and accumulating message', () => {
    const renderer = render(
      <ActivityTimeline
        active
        handle="Clara"
        items={TOOLS}
        messageDraft="The answer is arriving."
        stamp="now"
        thought="Checking the gate result…"
      />,
    );
    expect(renderer.root.findByProps({ testID: 'activity-thought-lane' })).toBeTruthy();
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

  it('routes complete streamed Markdown through the same transcript renderer in both lanes', () => {
    const renderer = render(
      <ActivityTimeline
        active
        items={[]}
        thought="**Analyzing trading economics and risks**"
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
    ).toEqual([
      {
        markdown: '**Analyzing trading economics and risks**',
        testID: 'activity-thought-draft',
      },
      { markdown: '**The reply is ready**', testID: 'activity-message-draft' },
    ]);
  });

  it('recedes thinking copy: prose family, one step down, dimmed, upright', () => {
    const renderer = render(<ActivityTimeline active items={TOOLS} thought="Still checking" />);
    const thought = renderer.root.findByProps({ testID: 'activity-thought-draft' });
    expect(thought.props.textStyle).toMatchObject({
      fontFamily: groknight.proseRegular,
      color: groknight.ledgerQuiet,
      fontSize: 14,
      lineHeight: 22,
    });
    // Upright: no simulated italics — the shipped family has no italic cut.
    expect(thought.props.textStyle).not.toHaveProperty('fontStyle');
    const verdict = renderer.root.findByProps({ testID: 'activity-verdict-failure' });
    expect(verdict.props.children).toBe('×');
    expect(verdict.props.style).toContainEqual(
      expect.objectContaining({ color: groknight.accent }),
    );
  });
});
