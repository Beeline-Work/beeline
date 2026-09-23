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
const { RoomCatchUpControls } = await import('@/components/buzz/RoomCatchUpControls');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
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

const rowFrom = (id: string, index: number, name: string): ChatDisplayMessage => ({
  ...row(id, index),
  authorIdentity: { pubkey: `pk-${name}`, kind: 'agent', name },
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
  openingUnreadCounts,
  pinnedToTail,
  enabled,
}: {
  messages: readonly ChatDisplayMessage[];
  arrivingIds: ReadonlySet<string>;
  firstUnreadMessageId: string | null;
  openingUnreadCounts: { messages: number; agentTurns: number } | null;
  pinnedToTail: boolean;
  enabled?: boolean;
}) {
  const control = useNewMessageControl({
    roomId: 'room-1',
    queueableMessages: messages,
    arrivingIds,
    newestMessageId: messages.at(-1)?.id ?? null,
    firstUnreadMessageId,
    openingUnreadCounts,
    isPinnedToTail: () => pinnedToTail,
    enabled,
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
      {/* The production controls, so what a reader can see here is what the
          Room draws. CHEV-21: the disc's press scrolls and settles NOTHING —
          only reaching the newest row clears the badge. */}
      <RoomCatchUpControls
        badgeCount={control.badgeCount}
        catchUpVisible={control.catchUpVisible}
        corner={enabled === false}
        discVisible={control.discVisible}
        onJumpToNewest={() => undefined}
        onOpenCatchUp={() => undefined}
      />
    </View>
  );
}

const { Text, View } = await import('react-native');

type HarnessProps = React.ComponentProps<typeof TranscriptHarness>;
const AT_TAIL: HarnessProps = {
  messages: SEED,
  arrivingIds: new Set<string>(),
  firstUnreadMessageId: null,
  openingUnreadCounts: null,
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

function strips(renderer: ReactTestRenderer) {
  return renderer.root.findAllByProps({ testID: 'catch-up-summary-strip' }, { deep: false });
}

function discs(renderer: ReactTestRenderer) {
  return renderer.root.findAllByProps({ testID: 'newest-jump-disc' }, { deep: false });
}

function badges(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByProps({ testID: 'newest-jump-badge' }, { deep: false })
    .map((badge: { findByType: (type: unknown) => { props: { children: string } } }) =>
      String(badge.findByType(Text).props.children),
    );
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

/**
 * The reader's own walk through a Room they are behind in, printed. Every
 * line is read off the mounted tree — the production row cell's glyph and the
 * production control's disc and bar — so what it claims is on screen cannot
 * outrun what the renderer actually built.
 */
function onScreen(renderer: ReactTestRenderer): string {
  const disc = discs(renderer);
  return [
    `unread glyph: ${dividerRowIds(renderer)[0] ?? 'none'}`,
    `catch-up bar: ${strips(renderer).length > 0 ? 'SHOWN' : 'none'}`,
    `jump disc: ${disc.length > 0 ? 'shown' : 'hidden'}`,
    `badge: ${badges(renderer)[0] ?? 'none'}`,
    `catch-up door: ${typeof disc[0]?.props.onLongPress === 'function' ? 'open' : 'closed'}`,
  ].join(' · ');
}

describe('the transcript new-message control', () => {
  it('UDIV-05/CHEV-22: walks a reader through a Room they are 15 behind in', () => {
    // A Room past the catch-up threshold, cursor on seed-2, opened landed on
    // that boundary with the newest row off screen.
    const open: HarnessProps = {
      ...AT_TAIL,
      firstUnreadMessageId: 'seed-2',
      openingUnreadCounts: { messages: 15, agentTurns: 6 },
      pinnedToTail: false,
    };
    const renderer = mount(open);
    const walk: string[] = [];
    report([SEED[1]!, SEED[2]!]);
    walk.push(`1 · opened 15 behind, landed on the boundary → ${onScreen(renderer)}`);

    // Two messages land while the reader is still up in history.
    const arrived = [...SEED, rowFrom('arrival-0', 5, 'Sol'), rowFrom('arrival-1', 6, 'Nerd')];
    update(renderer, { ...open, messages: arrived, arrivingIds: new Set(['arrival-0', 'arrival-1']) });
    walk.push(`2 · two messages arrive below the fold → ${onScreen(renderer)}`);

    // The reader scrolls down to the newest message under their own finger.
    report([arrived[6]!]);
    walk.push(`3 · scrolled down to the newest message → ${onScreen(renderer)}`);

    // And pages back up into history.
    report([SEED[1]!, SEED[2]!]);
    walk.push(`4 · paged back up into history → ${onScreen(renderer)}`);

    console.log(`\n${walk.join('\n')}\n`);
    expect(walk).toEqual([
      '1 · opened 15 behind, landed on the boundary → unread glyph: seed-2 · catch-up bar: none · jump disc: shown · badge: none · catch-up door: open',
      '2 · two messages arrive below the fold → unread glyph: seed-2 · catch-up bar: none · jump disc: shown · badge: 2 · catch-up door: open',
      '3 · scrolled down to the newest message → unread glyph: none · catch-up bar: none · jump disc: hidden · badge: none · catch-up door: closed',
      '4 · paged back up into history → unread glyph: none · catch-up bar: none · jump disc: shown · badge: none · catch-up door: closed',
    ]);
  });

  it('UDIV-05: the reader reaching the newest row retires the opening glyph', () => {
    const open: HarnessProps = {
      ...AT_TAIL,
      firstUnreadMessageId: 'seed-2',
      openingUnreadCounts: { messages: 15, agentTurns: 0 },
      pinnedToTail: false,
    };
    const renderer = mount(open);
    // The visit opens landed on the boundary, with the newest row off screen.
    report([SEED[1]!, SEED[2]!]);
    expect(dividerRowIds(renderer)).toEqual(['seed-2']);

    // The reader scrolls down to the newest message. There is nothing left
    // unread to mark, so the line goes.
    report([SEED[3]!, SEED[4]!]);
    expect(dividerRowIds(renderer)).toEqual([]);

    // And paging back into history does not bring it back for this visit.
    report([SEED[1]!, SEED[2]!]);
    expect(dividerRowIds(renderer)).toEqual([]);
  });

  it('UDIV-06: the opening viewability pass alone cannot retire the glyph', () => {
    // A short unread run: the boundary and the newest row are both on screen
    // the moment the Room opens. The reader has not moved, so the line stays.
    const renderer = mount({ ...AT_TAIL, firstUnreadMessageId: 'seed-3' });
    report([SEED[3]!, SEED[4]!]);
    expect(dividerRowIds(renderer)).toEqual(['seed-3']);
  });

  it('CHEV-22: a Room past the catch-up threshold floats no bar over the transcript', () => {
    const renderer = mount({
      ...AT_TAIL,
      firstUnreadMessageId: 'seed-2',
      openingUnreadCounts: { messages: 15, agentTurns: 6 },
      pinnedToTail: false,
    });
    report([SEED[1]!, SEED[2]!]);
    expect(strips(renderer)).toHaveLength(0);
    // The offer is on the disc the reader already has, not on a bar over the
    // transcript: a long press opens the sheet.
    expect(typeof discs(renderer)[0]!.props.onLongPress).toBe('function');
  });

  it('keeps only the tail chevron in corners, even with unread data and later arrivals', () => {
    const corner = {
      ...AT_TAIL,
      enabled: false,
      firstUnreadMessageId: 'seed-2',
      openingUnreadCounts: { messages: 15, agentTurns: 6 },
      pinnedToTail: false,
    };
    const renderer = mount(corner);
    report([SEED[1]!, SEED[2]!]);
    expect(discs(renderer)).toHaveLength(1);
    expect(dividerRowIds(renderer)).toEqual([]);
    expect(strips(renderer)).toHaveLength(0);
    expect(badges(renderer)).toEqual([]);

    update(renderer, {
      ...corner,
      messages: [...SEED, row('arrival-0', 5)],
      arrivingIds: new Set(['arrival-0']),
    });
    expect(discs(renderer)).toHaveLength(1);
    expect(dividerRowIds(renderer)).toEqual([]);
    expect(strips(renderer)).toHaveLength(0);
    expect(badges(renderer)).toEqual([]);
  });

  it('UDIV-04: keeps the opening glyph anchored while later arrivals use the jump control', () => {
    const open: HarnessProps = {
      ...AT_TAIL,
      firstUnreadMessageId: 'seed-2',
      openingUnreadCounts: { messages: 15, agentTurns: 0 },
    };
    const renderer = mount(open);
    report([SEED[1]!, SEED[2]!]);
    expect(dividerRowIds(renderer)).toEqual(['seed-2']);

    // A later arrival below the fold belongs to the jump control and cannot
    // move the anchored glyph.
    update(renderer, {
      ...open,
      messages: [...SEED, row('arrival-0', 5)],
      arrivingIds: new Set(['arrival-0']),
      pinnedToTail: false,
    });
    // The arrival raises the badge while the opening boundary stays put, and
    // nothing floats a bar over the transcript to say so.
    expect(badges(renderer)).toEqual(['1']);
    expect(strips(renderer)).toHaveLength(0);
    expect(dividerRowIds(renderer)).toEqual(['seed-2']);
  });

  it('UDIV-01: arms on an arrival below the fold and settles on the reader’s own return', () => {
    const renderer = mount(AT_TAIL);
    // Opening on the tail: the reader can see the newest row, so there is
    // nowhere to land and no disc.
    report([SEED[4]!]);
    expect(discs(renderer)).toHaveLength(0);
    expect(strips(renderer)).toHaveLength(0);

    // The reader pages back into history. The newest row is off screen, so the
    // disc comes up with no badge — nothing new has arrived to count.
    report([SEED[1]!, SEED[2]!]);
    expect(discs(renderer)).toHaveLength(1);
    expect(badges(renderer)).toEqual([]);
    expect(strips(renderer)).toHaveLength(0);

    // One message arrives below the fold. The viewable set is unchanged, so the
    // list has no reason to re-run its viewability pass and never reports — the
    // badge has to raise itself off the change of newest row alone.
    const arrived = [...SEED, row('arrival-0', 5)];
    update(renderer, {
      ...AT_TAIL,
      messages: arrived,
      arrivingIds: new Set(['arrival-0']),
      pinnedToTail: false,
    });
    expect(badges(renderer)).toEqual(['1']);
    // A Room that opened read has no cursor, so nothing was missed while away
    // and no strip is owed — however much arrives while the reader sits here.
    expect(strips(renderer)).toHaveLength(0);

    // The reader scrolls back to the tail under their own finger. No tap on the
    // disc: reaching the newest row is the whole thing the badge counted towards.
    report([SEED[4]!, arrived[5]!]);
    expect(badges(renderer)).toEqual([]);
    expect(strips(renderer)).toHaveLength(0);
    expect(discs(renderer)).toHaveLength(0);

    // And a settled queue cannot bring its old count back on the next scroll
    // away: the disc returns bare.
    report([SEED[1]!, SEED[2]!]);
    expect(discs(renderer)).toHaveLength(1);
    expect(badges(renderer)).toEqual([]);
    expect(strips(renderer)).toHaveLength(0);
  });

  it('UDIV-02: stays hidden while the newest row is on screen, however far off the tail', () => {
    const renderer = mount({ ...AT_TAIL, pinnedToTail: false });
    // The reader is in history, so the disc that carries the badge is up.
    report([SEED[1]!, SEED[2]!]);
    const arrived = [...SEED, row('arrival-0', 5)];
    update(renderer, {
      ...AT_TAIL,
      messages: arrived,
      arrivingIds: new Set(['arrival-0']),
      pinnedToTail: false,
    });
    // Queued, because tail distance said the reader was away from the tail.
    expect(badges(renderer)).toEqual(['1']);

    // But the reader is looking straight at the arrival. Slack shows nothing here.
    report([SEED[4]!, arrived[5]!]);
    expect(discs(renderer)).toHaveLength(0);
    expect(badges(renderer)).toEqual([]);
  });

  it('raises the control even though the last report said the newest row was on screen', () => {
    // The report before the arrival was taken while seed-4 was the newest row,
    // and it said seed-4 was on screen. The arrival lands below the fold, which
    // changes nothing about which rows are viewable, so the list never re-runs
    // its pass. Left alone, that stale "yes" would hide the control over a
    // message the reader cannot see.
    const renderer = mount({ ...AT_TAIL, pinnedToTail: false });
    report([SEED[3]!, SEED[4]!]);
    expect(strips(renderer)).toHaveLength(0);
    expect(discs(renderer)).toHaveLength(0);

    update(renderer, {
      ...AT_TAIL,
      messages: [...SEED, row('arrival-0', 5)],
      arrivingIds: new Set(['arrival-0']),
      pinnedToTail: false,
    });
    expect(badges(renderer)).toEqual(['1']);
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
    expect(strips(renderer)).toHaveLength(0);
    expect(badges(renderer)).toEqual([]);
  });

  it('CHEV-15: the offer rides the disc, and catching up ends it with the glyph', () => {
    // A Room that opened past the threshold. Nothing is drawn over the
    // transcript to say so: the door is a long press on the disc.
    const open: HarnessProps = {
      ...AT_TAIL,
      firstUnreadMessageId: 'seed-2',
      openingUnreadCounts: { messages: 15, agentTurns: 0 },
      pinnedToTail: false,
    };
    const renderer = mount(open);
    report([SEED[1]!, SEED[2]!]);
    expect(strips(renderer)).toHaveLength(0);
    expect(typeof discs(renderer)[0]!.props.onLongPress).toBe('function');

    // Arrivals during the visit raise the badge and leave the line alone.
    const arrived = [...SEED, rowFrom('arrival-0', 5, 'Sol'), rowFrom('arrival-1', 6, 'Nerd')];
    update(renderer, {
      ...open,
      messages: arrived,
      arrivingIds: new Set(['arrival-0', 'arrival-1']),
    });
    expect(badges(renderer)).toEqual(['2']);
    expect(dividerRowIds(renderer)).toEqual(['seed-2']);

    // The reader reaches newest. The run is read: badge, glyph and the offer
    // that stood for that run all go together.
    report([arrived[6]!]);
    expect(badges(renderer)).toEqual([]);
    expect(dividerRowIds(renderer)).toEqual([]);
    report([SEED[1]!, SEED[2]!]);
    expect(discs(renderer)[0]!.props.onLongPress).toBeUndefined();
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
    // The badge is up, and the transcript still carries no divider at all —
    // the reported failure was one appearing beneath that very arrival. No
    // strip either: a Room that opened read has no unread run to date.
    expect(badges(renderer)).toEqual(['1']);
    expect(strips(renderer)).toHaveLength(0);
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
