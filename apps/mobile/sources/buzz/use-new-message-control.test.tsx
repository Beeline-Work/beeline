import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(
      name,
      props,
      typeof props.children === 'function' ? props.children({ pressed: false }) : props.children,
    );
  return {
    Platform: { OS: 'android', select: (choice: any) => choice.android ?? choice.default },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
    Pressable: host('Pressable'),
  };
});
// The day caption is the Ledger's business, not the divider's; keep the whole
// Ledger tree out of this test without replacing the cell that places the line.
vi.mock('@/components/buzz/Ledger', () => ({
  withLedgerDayCaption: (node: React.ReactNode) => node,
}));

const { useRoomMessageRenderItem } = await import('./room-message-cell');
const { useNewMessageControl } = await import('./use-new-message-control');
const { compactNewMessageCount } = await import('./room-new-message-boundary');

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const originalConsoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

const row = (id: string, index: number): ChatDisplayMessage => ({
  id,
  text: id,
  isUser: false,
  timestamp: 1_700_000_000_000 + index * 1000,
});

const SEED = ['seed-0', 'seed-1', 'seed-2', 'seed-3', 'seed-4'].map(row);

/**
 * Everything the production surface gives the control: the folded rows in
 * transcript order, the ids that just arrived, the server's opening cursor,
 * and a tail-distance reading. The reader's eye is the one thing a unit test
 * has to stand in for, so `report` plays the list's viewability pass.
 */
const handles: {
  report?: (visible: readonly ChatDisplayMessage[]) => void;
} = {};

function TranscriptHarness({
  messages,
  arrivingIds,
  firstUnreadMessageId,
  pinnedToTail,
}: {
  messages: readonly ChatDisplayMessage[];
  arrivingIds: ReadonlySet<string>;
  firstUnreadMessageId: string | null;
  pinnedToTail: boolean;
}) {
  const control = useNewMessageControl({
    roomId: 'room-1',
    queueableMessages: messages,
    arrivingIds,
    newestMessageId: messages.at(-1)?.id ?? null,
    firstUnreadMessageId,
    isPinnedToTail: () => pinnedToTail,
  });
  handles.report = control.observeVisibleMessages;
  const renderItem = useRoomMessageRenderItem({
    render: (item) => <Text>{item.text}</Text>,
    continuedIds: React.useMemo(() => new Set<string>(), []),
    precedingMessageById: React.useMemo(() => new Map<string, ChatDisplayMessage>(), []),
    messageById: React.useMemo(() => new Map<string, ChatDisplayMessage>(), []),
    firstNewMessageId: control.dividerMessageId,
  });
  return (
    <View>
      {messages.map((item) => (
        <View key={item.id} testID={`row-${item.id}`}>
          {renderItem({ item })}
        </View>
      ))}
      {control.controlVisible && (
        <Pressable
          onPress={() => control.settleQueueAtBoundary(control.queue.boundaryId!)}
          testID="new-message-control"
        >
          <Text>{`${compactNewMessageCount(control.queue.count)} new`}</Text>
        </Pressable>
      )}
    </View>
  );
}

const { Pressable, Text, View } = await import('react-native');

type HarnessProps = React.ComponentProps<typeof TranscriptHarness>;
const AT_TAIL: HarnessProps = {
  messages: SEED,
  arrivingIds: new Set<string>(),
  firstUnreadMessageId: null,
  pinnedToTail: true,
};

function mount(props: HarnessProps): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<TranscriptHarness {...props} />);
  });
  return renderer;
}

function update(renderer: ReactTestRenderer, props: HarnessProps): void {
  act(() => renderer.update(<TranscriptHarness {...props} />));
}

function report(visible: readonly ChatDisplayMessage[]): void {
  act(() => handles.report?.(visible));
}

function controls(renderer: ReactTestRenderer) {
  return renderer.root.findAllByProps({ testID: 'new-message-control' }, { deep: false });
}

function dividerRowIds(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByProps({ testID: 'new-messages-divider' }, { deep: false })
    .map((divider: { parent: any }) => {
      for (let node = divider.parent; node; node = node.parent) {
        const testID = node.props?.testID;
        if (typeof testID === 'string' && testID.startsWith('row-')) return testID.slice(4);
      }
      return 'unattached';
    });
}

describe('the transcript new-message control', () => {
  it('UDIV-01: arms on an arrival below the fold and settles on the reader’s own return', () => {
    const renderer = mount(AT_TAIL);
    // Opening on the tail: the reader can see the newest row, so nothing to jump to.
    report([SEED[4]!]);
    expect(controls(renderer)).toHaveLength(0);

    // The reader pages back into history. Tail distance changes; nothing shows yet.
    report([SEED[1]!, SEED[2]!]);
    expect(controls(renderer)).toHaveLength(0);

    // One message arrives below the fold. The viewable set is unchanged, so the
    // list has no reason to re-run its viewability pass and never reports — the
    // control has to raise itself off the change of newest row alone.
    const arrived = [...SEED, row('arrival-0', 5)];
    update(renderer, {
      ...AT_TAIL,
      messages: arrived,
      arrivingIds: new Set(['arrival-0']),
      pinnedToTail: false,
    });
    expect(controls(renderer)).toHaveLength(1);
    expect(controls(renderer)[0]!.findByType(Text).props.children).toBe('1 new');

    // The reader scrolls back to the tail under their own finger. No tap on the
    // control: reaching the newest row is the whole thing the control asked for.
    report([SEED[4]!, arrived[5]!]);
    expect(controls(renderer)).toHaveLength(0);

    // And a settled queue cannot bring its old count back on the next scroll away.
    report([SEED[1]!, SEED[2]!]);
    expect(controls(renderer)).toHaveLength(0);
  });

  it('UDIV-02: stays hidden while the newest row is on screen, however far off the tail', () => {
    const renderer = mount({ ...AT_TAIL, pinnedToTail: false });
    const arrived = [...SEED, row('arrival-0', 5)];
    update(renderer, {
      ...AT_TAIL,
      messages: arrived,
      arrivingIds: new Set(['arrival-0']),
      pinnedToTail: false,
    });
    // Queued, because tail distance said the reader was away from the tail.
    expect(controls(renderer)).toHaveLength(1);

    // But the reader is looking straight at the arrival. Slack shows nothing here.
    report([SEED[4]!, arrived[5]!]);
    expect(controls(renderer)).toHaveLength(0);
  });

  it('raises the control even though the last report said the newest row was on screen', () => {
    // The report before the arrival was taken while seed-4 was the newest row,
    // and it said seed-4 was on screen. The arrival lands below the fold, which
    // changes nothing about which rows are viewable, so the list never re-runs
    // its pass. Left alone, that stale "yes" would hide the control over a
    // message the reader cannot see.
    const renderer = mount({ ...AT_TAIL, pinnedToTail: false });
    report([SEED[3]!, SEED[4]!]);
    expect(controls(renderer)).toHaveLength(0);

    update(renderer, {
      ...AT_TAIL,
      messages: [...SEED, row('arrival-0', 5)],
      arrivingIds: new Set(['arrival-0']),
      pinnedToTail: false,
    });
    expect(controls(renderer)).toHaveLength(1);
  });

  it('shows no control for an arrival folded into a host row already on screen', () => {
    // A fold gains a durable id without changing the id of the row that carries
    // it, so the arrival joins the queue while the newest row is unchanged and
    // still visible. There is nothing to jump to; only viewport visibility can
    // tell the control that, because the count says otherwise.
    const host = { ...row('host-4', 4), foldedIds: ['fold-a'] };
    const opened: HarnessProps = { ...AT_TAIL, messages: [...SEED.slice(0, 4), host] };
    const renderer = mount(opened);
    report([host]);

    update(renderer, {
      ...opened,
      messages: [...SEED.slice(0, 4), { ...host, foldedIds: ['fold-a', 'fold-b'] }],
      arrivingIds: new Set(['fold-b']),
      pinnedToTail: false,
    });
    expect(controls(renderer)).toHaveLength(0);
  });

  it('UDIV-03: a live arrival never creates a divider in a Room that opened read', () => {
    const renderer = mount(AT_TAIL);
    report([SEED[1]!, SEED[2]!]);
    expect(dividerRowIds(renderer)).toEqual([]);

    update(renderer, {
      ...AT_TAIL,
      messages: [...SEED, row('arrival-0', 5)],
      arrivingIds: new Set(['arrival-0']),
      pinnedToTail: false,
    });
    // The control is up, and the transcript still carries no divider at all —
    // the reported failure was one appearing beneath that very arrival.
    expect(controls(renderer)).toHaveLength(1);
    expect(dividerRowIds(renderer)).toEqual([]);
  });

  it('UDIV-03: a live arrival never moves the divider off the opening cursor', () => {
    const open: HarnessProps = { ...AT_TAIL, firstUnreadMessageId: 'seed-2' };
    const renderer = mount(open);
    report([SEED[1]!, SEED[2]!]);
    expect(dividerRowIds(renderer)).toEqual(['seed-2']);

    update(renderer, {
      ...open,
      messages: [...SEED, row('arrival-0', 5)],
      arrivingIds: new Set(['arrival-0']),
      pinnedToTail: false,
    });
    // Exactly one divider, still on the row the visit opened at.
    expect(dividerRowIds(renderer)).toEqual(['seed-2']);
  });
});
