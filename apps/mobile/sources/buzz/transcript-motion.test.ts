import { describe, expect, it } from 'vitest';
import { anchorCornerMarkers } from './corner-markers';
import {
  EMPTY_NEW_MESSAGE_QUEUE,
  compactNewMessageCount,
  messageBoundaryIds,
  newMessageBadgeCount,
  queueIncomingMessages,
  type NewMessageQueue,
} from './room-new-message-boundary';
import {
  foldSettledActivityRuns,
  mergeDisplayPages,
  type ChatDisplayMessage,
} from './room-view-presentation';
import { anchorRelayReports, foldSystemLines } from './system-lines';
import {
  EMPTY_TRANSCRIPT_ARRIVAL_STATE,
  TRANSCRIPT_SETTLE_MS,
  observeTranscriptArrivals,
  transcriptSettleDecision,
  transcriptSteadyColors,
} from './transcript-motion';

describe('transcript brass-glow decisions', () => {
  it('seeds the first hydrated render without calling history new', () => {
    const observed = observeTranscriptArrivals(EMPTY_TRANSCRIPT_ARRIVAL_STATE, {
      surfaceId: 'room-1',
      hydrated: true,
      ids: ['old-card'],
    });
    expect([...observed.arrivingIds]).toEqual([]);
    expect(observed.state.seenIds.has('old-card')).toBe(true);
  });

  it('marks a later live append exactly once', () => {
    const initial = observeTranscriptArrivals(EMPTY_TRANSCRIPT_ARRIVAL_STATE, {
      surfaceId: 'room-1',
      hydrated: true,
      ids: ['old-card'],
    });
    const appended = observeTranscriptArrivals(initial.state, {
      surfaceId: 'room-1',
      hydrated: true,
      ids: ['old-card', 'new-card'],
    });
    expect([...appended.arrivingIds]).toEqual(['new-card']);
    expect([
      ...observeTranscriptArrivals(appended.state, {
        surfaceId: 'room-1',
        hydrated: true,
        ids: ['old-card', 'new-card'],
      }).arrivingIds,
    ]).toEqual([]);
  });

  it('does not call an older page that loads above the transcript an arrival', () => {
    const initial = observeTranscriptArrivals(EMPTY_TRANSCRIPT_ARRIVAL_STATE, {
      surfaceId: 'room-1',
      hydrated: true,
      ids: ['m-20', 'm-21'],
    });
    const older = Array.from({ length: 20 }, (_, index) => `m-${index}`);
    const paged = observeTranscriptArrivals(initial.state, {
      surfaceId: 'room-1',
      hydrated: true,
      ids: [...older, 'm-20', 'm-21'],
    });
    expect([...paged.arrivingIds]).toEqual([]);
    expect(paged.state.seenIds.has('m-0')).toBe(true);
    const appended = observeTranscriptArrivals(paged.state, {
      surfaceId: 'room-1',
      hydrated: true,
      ids: [...older, 'm-20', 'm-21', 'm-22'],
    });
    expect([...appended.arrivingIds]).toEqual(['m-22']);
  });

  it('collapses a same-card burst into the settle already in flight', () => {
    expect(transcriptSettleDecision(null, 1_000, false)).toEqual({
      animate: true,
      startsNewSettle: true,
      durationMs: TRANSCRIPT_SETTLE_MS,
    });
    expect(transcriptSettleDecision(1_000, 1_600, false)).toEqual({
      animate: true,
      startsNewSettle: false,
      durationMs: 1_200,
    });
  });

  it('renders every change settled when reduced motion is enabled', () => {
    expect(transcriptSettleDecision(null, 1_000, true)).toEqual({
      animate: false,
      startsNewSettle: false,
      durationMs: 0,
    });
  });

  it('settles onto the existing theme tokens', () => {
    const palette = {
      textPrimary: '#primary',
      textSecondary: '#secondary',
      quiet: '#quiet',
      ghost: '#ghost',
      waiting: '#accent',
      failed: '#failed',
    };
    expect(transcriptSteadyColors(palette)).toEqual({
      title: palette.textPrimary,
      body: palette.textSecondary,
      quiet: palette.quiet,
      rowTitle: palette.textPrimary,
      rowKind: palette.ghost,
      rowState: {
        settled: palette.quiet,
        waiting: palette.waiting,
        failed: palette.failed,
      },
    });
  });
});

describe('the jump-to-newest badge while older pages load', () => {
  const at = (index: number) => 1_000 + index;
  const plain = (index: number): ChatDisplayMessage => ({
    id: `m-${index}`,
    text: `message ${index}`,
    timestamp: at(index),
    isUser: false,
  });
  const cornerCard = (index: number): ChatDisplayMessage => ({
    id: `card-${index}`,
    text: 'Opened',
    timestamp: at(index),
    isUser: false,
    daemonFact: { type: 'corner-open', cornerId: 'c', objective: 'Work', name: 'Work' },
  });
  const cornerReport = (index: number, cardIndex: number): ChatDisplayMessage => ({
    id: `report-${index}`,
    text: 'Ready for review',
    timestamp: at(index),
    isUser: false,
    relay: { direction: 'up', anchorMessageId: `card-${cardIndex}` },
  });
  const checkLine = (index: number): ChatDisplayMessage => ({
    id: `check-${index}`,
    text: 'GitHub passed a check Build',
    timestamp: at(index),
    isUser: false,
    isSystemNotice: true,
    systemEvent: {
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      object: { text: 'Build', url: 'https://github.test/a/r/pull/1/checks', headSha: 'abc123' },
    },
  });

  /** The Room transcript's own pipeline from server rows to the badge it draws. */
  function room(tail: readonly ChatDisplayMessage[]) {
    let arrivals = EMPTY_TRANSCRIPT_ARRIVAL_STATE;
    let queue: NewMessageQueue = EMPTY_NEW_MESSAGE_QUEUE;
    const render = (older: readonly ChatDisplayMessage[], current = tail) => {
      const folded = foldSystemLines(
        foldSettledActivityRuns(
          anchorCornerMarkers(anchorRelayReports(mergeDisplayPages(older, current))),
        ),
      );
      const observed = observeTranscriptArrivals(arrivals, {
        surfaceId: 'room-1',
        hydrated: true,
        ids: folded.flatMap(messageBoundaryIds),
        historyIds: new Set(older.map((message) => message.id)),
      });
      arrivals = observed.state;
      // The reader is up in history, away from the tail.
      queue = queueIncomingMessages(queue, {
        messages: folded,
        arrivingIds: observed.arrivingIds,
        isPinnedToTail: false,
      });
      const count = newMessageBadgeCount(queue, false);
      return count === 0 ? null : compactNewMessageCount(count);
    };
    return { render };
  }

  it('draws no badge when an older corner card takes a report the reader already saw', () => {
    // The corner opened two pages back; its report is in the tail.
    const tail = [cornerReport(40, 5), ...Array.from({ length: 10 }, (_, i) => plain(41 + i))];
    const olderPage = [
      ...Array.from({ length: 5 }, (_, i) => plain(i)),
      cornerCard(5),
      ...Array.from({ length: 30 }, (_, i) => plain(6 + i)),
    ];
    const surface = room(tail);
    expect(surface.render([])).toBeNull();
    expect(surface.render(olderPage)).toBeNull();
  });

  it('draws no badge when an older check folds with a check the reader already saw', () => {
    const tail = [checkLine(40), ...Array.from({ length: 10 }, (_, i) => plain(41 + i))];
    const olderPage = [
      ...Array.from({ length: 5 }, (_, i) => plain(i)),
      checkLine(5),
      ...Array.from({ length: 30 }, (_, i) => plain(6 + i)),
    ];
    const surface = room(tail);
    expect(surface.render([])).toBeNull();
    expect(surface.render(olderPage)).toBeNull();
  });

  it('still counts one real arrival while the reader is in loaded history', () => {
    const tail = [cornerReport(40, 5), ...Array.from({ length: 10 }, (_, i) => plain(41 + i))];
    const olderPage = [cornerCard(5), ...Array.from({ length: 30 }, (_, i) => plain(6 + i))];
    const surface = room(tail);
    surface.render([]);
    surface.render(olderPage);
    expect(surface.render(olderPage, [...tail, plain(60)])).toBe('1');
  });
});
