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
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});

let reducedMotion = false;
vi.mock('react-native-reanimated', () => ({ useReducedMotion: () => reducedMotion }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('./IdentityMark', () => ({
  IdentityMark: (props: any) => React.createElement('IdentityMark', props),
}));
vi.mock('./MonoMarkdown', () => ({
  MonoMarkdown: (props: any) => React.createElement('MonoMarkdown', props, props.markdown),
}));
vi.mock('./BeelineMarkSpinner', () => ({
  BeelineMarkSpinner: (props: any) => React.createElement('BeelineMarkSpinner', props),
}));
vi.mock('./HullActionSheet', () => ({
  HULL_SHEET_INSET: 22,
  HullActionSheetModal: (props: any) =>
    React.createElement('HullActionSheetModal', props, props.children),
  HullActionSheetRow: (props: any) => React.createElement('HullActionSheetRow', props, props.label),
}));
vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn().mockResolvedValue(undefined),
}));

import { groknight } from '@/buzz/groknight';
import { ActivityTimeline } from './ActivityTimeline';
import { LedgerEntry, LedgerSystemLine, provisionalProseStyle } from './Ledger';
import { displayRoomMessage } from '@/buzz/room-view-presentation';

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

it.each(['web', 'ios', 'android'])('renders a workflow system notice without a speaker byline on %s', async (platform) => {
  const { Platform } = await import('react-native');
  Platform.OS = platform as typeof Platform.OS;
  const text = 'Impy started workflow corner · run 7a434a73';
  const message = displayRoomMessage({
    id: 'workflow-start', text, createdAt: 1, presentation: 'system',
    author: { pubkey: 'impy', name: 'Impy', kind: 'agent' },
    systemEvent: { subject: { kind: 'agent', id: 'impy', name: 'Impy' },
      verb: 'started workflow', object: { text: 'corner', url: '/beeline/workflow-run?runId=7a434a73' },
      consequence: 'run 7a434a73' },
  }, 'viewer');
  expect(message.isSystemNotice).toBe(true);
  expect(message.text).toBe(text);
  const onOpenUrl = vi.fn();
  const renderer = render(<LedgerSystemLine id={message.id} text={message.text}
    event={message.systemEvent} stamp="09:41" onOpenUrl={onOpenUrl} />);
  expect(renderer.root.findAllByType('MonoMarkdown')).toEqual([]);
  expect(renderer.root.findAllByProps({ testID: 'chat-byline-profile' })).toEqual([]);
  const object = renderer.root.findByProps({ testID: 'system-line-object-workflow-start' });
  act(() => object.props.onPress());
  expect(onOpenUrl).toHaveBeenCalledWith('/beeline/workflow-run?runId=7a434a73');
  expect(JSON.stringify(renderer.toJSON())).toContain('started workflow');
  act(() => renderer.unmount());
  Platform.OS = 'android';
});

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
  it('writes a streaming turn in the quiet tone and a settled one content-toned, both in the prose face', () => {
    const provisional = streamingRow().root.findByProps({ testID: 'activity-message-draft' }).props
      .textStyle;
    expect(provisional.fontFamily).toBe(groknight.proseRegular);
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
    expect(draft.props.textStyle.fontFamily).toBe(groknight.proseRegular);
  });

  it('settles instantly under reduced motion, and still writes the draft as provisional', () => {
    reducedMotion = true;
    const renderer = settledRow({ settleFrom: 'Done. The answer is 4' });
    expect(renderer.root.findAllByProps({ testID: 'ledger-settle-ghost' })).toEqual([]);
    expect(markdownAt(renderer, 'body')[0]!.props.markdown).toBe('The answer is 42.');
    expect(vi.getTimerCount()).toBe(0);

    const provisional = streamingRow().root.findByProps({ testID: 'activity-message-draft' }).props
      .textStyle;
    expect(provisional.fontFamily).toBe(groknight.proseRegular);
    expect(provisional.color).toBe(groknight.ledgerQuiet);
  });
});
