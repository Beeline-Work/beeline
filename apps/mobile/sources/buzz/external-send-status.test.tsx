import React, { useState } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beelineThemes } from './groknight';
import { selectComposerAckPresentation, type PendingComposerAck } from './room-indicators';
import { useComposerAckExpiry } from './use-composer-ack-expiry';

vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
vi.mock('@/components/buzz/MonoHull', () => ({ HullLivePulse: 'HullLivePulse' }));
vi.mock('@/components/buzz/Button', () => ({ Button: 'Button' }));
vi.mock('@/components/buzz/BeelineMarkSpinner', () => ({ BeelineMarkSpinner: 'BeelineMarkSpinner', MARK_CELL: 18 }));
const current = vi.hoisted(() => ({ theme: 'obsidian' as 'obsidian' | 'bone' }));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (definition: any) => new Proxy({}, {
    get: (_, key) => definition({ buzz: beelineThemes[current.theme] })[key],
  }) },
}));
import { TurnProgressLine } from '@/components/buzz/TurnProgressLine';

let tree: ReturnType<typeof create>;
let changePending: React.Dispatch<React.SetStateAction<PendingComposerAck | null>>;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});
afterEach(() => {
  if (tree) act(() => tree.unmount());
  vi.useRealTimers();
});
const accepted = (handles = ['atlas', 'nova']): PendingComposerAck => ({
  sentAt: Date.now(), requestId: 'stored-message', externalHandles: handles,
});
function Harness({ initial }: { initial: PendingComposerAck | null }) {
  const [pending, setPending] = useState(initial);
  changePending = setPending;
  useComposerAckExpiry(pending, setPending);
  const presentation = selectComposerAckPresentation({
    isCorner: false, now: Date.now(),
    ...(pending ? { pendingAckSentAt: pending.sentAt, externalHandles: pending.externalHandles } : {}),
  });
  return presentation ? <TurnProgressLine {...presentation} /> : null;
}

it('shows the accepted recipients immediately and removes the line at exactly three seconds', () => {
  act(() => { tree = create(<Harness initial={accepted()} />); });
  expect(tree.root.findByType('Text').props.children).toBe('Sent to @atlas, @nova');
  expect(tree.root.findAllByType('HullLivePulse')).toHaveLength(0);
  expect(tree.root.findByType('BeelineMarkSpinner').props.live).toBeFalsy();
  expect(tree.root.findAllByType('Button')).toHaveLength(0);
  act(() => vi.advanceTimersByTime(2_999));
  expect(tree.root.findAllByType('Text')).toHaveLength(1);
  act(() => vi.advanceTimersByTime(1));
  expect(tree.toJSON()).toBeNull();
});

it('expires an acknowledgement from its acceptance time, without extending it on remount', () => {
  const pending = accepted();
  vi.advanceTimersByTime(2_500);
  act(() => { tree = create(<Harness initial={pending} />); });
  act(() => vi.advanceTimersByTime(499));
  expect(tree.toJSON()).not.toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(tree.toJSON()).toBeNull();
});

it('does not show Sent before acceptance or for a native send', () => {
  act(() => { tree = create(<Harness initial={{ sentAt: Date.now() }} />); });
  expect(tree.root.findByType('Text').props.children).toBe('sending…');
  expect(tree.root.findAllByType('HullLivePulse')).toHaveLength(1);
  expect(selectComposerAckPresentation({ isCorner: false, now: Date.now() })).toBeNull();
});

describe.each(['bone', 'obsidian'] as const)('%s approved one-line style', (theme) => {
  it('clips long handles at the tail using the thinking line font, color and static mark', () => {
    current.theme = theme;
    act(() => { tree = create(<Harness initial={accepted(['long-handle-'.repeat(20), 'nova'])} />); });
    const text = tree.root.findByType('Text');
    expect(text.props.numberOfLines).toBe(1);
    expect(text.props.ellipsizeMode).toBe('tail');
    expect(text.props.style).toMatchObject({
      ...beelineThemes[theme].type.machine, lineHeight: 18, color: beelineThemes[theme].accent,
      flexShrink: 1, minWidth: 0,
    });
    expect(tree.root.findByType('BeelineMarkSpinner').props.live).toBeFalsy();
  });
});

it('keeps a native working receipt, its counter and Stop ahead of an external acknowledgement', () => {
  const input = { isCorner: false, now: Date.now(), activeTurnPubkey: 'native',
    activeTurnRequestId: 'turn', activeTurnStartedAt: 95, viewerPubkey: 'person', viewerCanSend: true };
  const native = selectComposerAckPresentation(input);
  expect(selectComposerAckPresentation({ ...input, pendingAckSentAt: Date.now(), externalHandles: ['atlas'] }))
    .toEqual(native);
  act(() => { tree = create(<TurnProgressLine {...native!} onStop={() => undefined} />); });
  expect(tree.root.findAllByType('HullLivePulse')).toHaveLength(1);
  expect(tree.root.findByType('BeelineMarkSpinner').props.live).toBe(true);
  expect(tree.root.findAllByType('Button')).toHaveLength(1);
  expect(native?.stop).toEqual({ agentPubkey: 'native', requestId: 'turn' });
});

it('a newer accepted send receives its own full three seconds and releases its deadline on unmount', () => {
  act(() => { tree = create(<Harness initial={accepted(['atlas'])} />); });
  act(() => vi.advanceTimersByTime(2_999));
  act(() => changePending(accepted(['nova'])));
  act(() => vi.advanceTimersByTime(1));
  expect(tree.root.findByType('Text').props.children).toBe('Sent to @nova');
  act(() => vi.advanceTimersByTime(2_998));
  expect(tree.toJSON()).not.toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(tree.toJSON()).toBeNull();
  act(() => changePending(accepted()));
  expect(vi.getTimerCount()).toBe(1);
  act(() => tree.unmount());
  expect(vi.getTimerCount()).toBe(0);
});
