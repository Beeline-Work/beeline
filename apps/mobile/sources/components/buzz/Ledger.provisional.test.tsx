import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Linking: { openURL: vi.fn() },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

let reducedMotion = false;
vi.mock('react-native-reanimated', () => ({ useReducedMotion: () => reducedMotion }));
vi.mock('./IdentityMark', () => ({
  IdentityMark: (props: any) => React.createElement('IdentityMark', props),
}));
vi.mock('./MonoMarkdown', () => ({
  MonoMarkdown: (props: any) => React.createElement('MonoMarkdown', props, props.markdown),
}));

import { groknight } from '@/buzz/groknight';
import { ActivityTimeline } from './ActivityTimeline';
import { LedgerEntry, provisionalProseStyle } from './Ledger';

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
beforeEach(() => {
  reducedMotion = false;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

const MARK = { seed: 'a'.repeat(64), kind: 'agent' as const, alive: true };
const BYLINE = { name: 'Clara', role: 'agent', stamp: '09:41', mark: MARK };
/** Two sentences, so the settled turn has both a lead and a body to compare. */
const REPLY = 'Done. The answer is 42.';

function streamingRow(draft = REPLY) {
  return render(
    <ActivityTimeline active handle="Clara" items={[]} mark={MARK} messageDraft={draft} stamp="09:41" />,
  );
}

function settledRow(props: Record<string, unknown> = {}) {
  return render(
    <LedgerEntry bodyTestID="body" bodyText={REPLY} byline={BYLINE} itemId="m1" luminous {...props} />,
  );
}

function markdownAt(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    (node: { type: unknown; props: { testID?: string } }) =>
      node.type === 'MonoMarkdown' && node.props.testID === testID,
  );
}

describe('provisional prose (C98)', () => {
  it('writes a streaming turn in the italic, quiet face and a settled one upright and content-toned', () => {
    const provisional = streamingRow().root.findByProps({ testID: 'activity-message-draft' }).props
      .textStyle;
    expect(provisional.fontFamily).toBe(groknight.proseItalic);
    expect(provisional.color).toBe(groknight.ledgerQuiet);

    const settled = markdownAt(settledRow(), 'body')[0]!.props.textStyle;
    expect(settled.fontFamily).toBe(groknight.proseRegular);
    expect(settled.color).toBe(groknight.ledgerBody);

    // The change is tone and face ONLY: the words keep their size, their
    // leading and their column, so nothing reflows when the turn settles.
    expect(provisional.fontSize).toBe(settled.fontSize);
    expect(provisional.lineHeight).toBe(settled.lineHeight);
    expect(provisional.width).toBe(settled.width);
  });

  it('renders the same byline, node for node, in both states', () => {
    const streaming = streamingRow().toJSON();
    const settled = settledRow().toJSON();
    expect(streaming.children[0]).toEqual(settled.children[0]);
  });

  it('cross-fades out of the provisional text once, and leaves the settled words in place', () => {
    const renderer = settledRow({ settleFrom: 'Done. The answer is 4' });
    const ghost = renderer.root.findByProps({ testID: 'ledger-settle-ghost' });
    expect(ghost.props.markdown).toBe('Done. The answer is 4');
    expect(ghost.props.textStyle).toEqual(provisionalProseStyle());
    // The settled words are already laid out underneath, still invisible.
    expect(markdownAt(renderer, 'body')[0]!.props.markdown).toBe('The answer is 42.');

    act(() => vi.advanceTimersByTime(300));

    expect(renderer.root.findAllByProps({ testID: 'ledger-settle-ghost' })).toEqual([]);
    expect(renderer.root.findAllByProps({ testID: 'ledger-settle' })).toEqual([]);
    expect(markdownAt(renderer, 'body')[0]!.props.markdown).toBe('The answer is 42.');
    // One transition: nothing is left ticking.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never re-types a reply the reader already watched stream', () => {
    const renderer = settledRow({ settleFrom: 'Done. The answer is 4', typewriter: true });
    expect(markdownAt(renderer, 'body')[0]!.props.markdown).toBe('The answer is 42.');
    act(() => vi.advanceTimersByTime(300));
    expect(markdownAt(renderer, 'body')[0]!.props.markdown).toBe('The answer is 42.');
  });

  it('keeps a retracted draft on the page instead of emptying the row', () => {
    // The turn failed: the lane is no longer live and no durable reply will
    // ever replace it. What the reader was reading stays, provisional, and the
    // server's failure line stands beneath it.
    const renderer = render(
      <ActivityTimeline
        active={false}
        handle="Clara"
        items={[]}
        mark={{ ...MARK, alive: false }}
        messageDraft="The answer is"
        stamp="09:41"
      />,
    );
    expect(renderer.toJSON()).not.toBeNull();
    const draft = renderer.root.findByProps({ testID: 'activity-message-draft' });
    expect(draft.props.markdown).toBe('The answer is');
    expect(draft.props.textStyle.fontFamily).toBe(groknight.proseItalic);
  });

  it('settles instantly under reduced motion, and still writes the draft as provisional', () => {
    reducedMotion = true;
    const renderer = settledRow({ settleFrom: 'Done. The answer is 4' });
    expect(renderer.root.findAllByProps({ testID: 'ledger-settle-ghost' })).toEqual([]);
    expect(markdownAt(renderer, 'body')[0]!.props.markdown).toBe('The answer is 42.');
    expect(vi.getTimerCount()).toBe(0);

    const provisional = streamingRow().root.findByProps({ testID: 'activity-message-draft' }).props
      .textStyle;
    expect(provisional.fontFamily).toBe(groknight.proseItalic);
    expect(provisional.color).toBe(groknight.ledgerQuiet);
  });
});
