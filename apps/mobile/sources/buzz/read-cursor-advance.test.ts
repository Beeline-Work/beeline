import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import {
  newestVisibleMessageId,
  ReadCursorAdvancer,
  READ_CURSOR_DEBOUNCE_MS,
} from './read-cursor-advance';

function row(id: string, extra: Partial<ChatDisplayMessage> = {}): ChatDisplayMessage {
  return { id, text: id, isUser: false, timestamp: 0, ...extra } as ChatDisplayMessage;
}

const TRANSCRIPT = [row('a'), row('b'), row('c'), row('d')];

/**
 * What `_chat-surface.tsx` renders on a phone: `[...visibleMessages].reverse()`
 * for the inverted FlatList. The advancer must never be handed this array, and
 * these cases prove what happens to a reader if it is.
 */
const NATIVE_ORDER = [...TRANSCRIPT].reverse();

describe('newestVisibleMessageId', () => {
  it('names the newest row the viewport can see, not the newest row that exists', () => {
    expect(newestVisibleMessageId(TRANSCRIPT, [TRANSCRIPT[0]!, TRANSCRIPT[1]!])).toBe('b');
  });

  it('ignores the order the list happens to report its viewable rows in', () => {
    expect(newestVisibleMessageId(TRANSCRIPT, [TRANSCRIPT[2]!, TRANSCRIPT[0]!])).toBe('c');
  });

  it('credits every durable id a folded row carries', () => {
    const folded = [row('a'), row('b', { foldedIds: ['b1', 'b2'] })];
    expect(newestVisibleMessageId(folded, [folded[1]!])).toBe('b2');
  });

  it('names nothing when the viewport is empty', () => {
    expect(newestVisibleMessageId(TRANSCRIPT, [])).toBeNull();
  });

  // Reproduction NATIVE-INVERTED-CURSOR. The phone's list renders
  // [...visibleMessages].reverse(); ranking THAT array by index names the
  // oldest visible row. Rows 'c' and 'b' on screen must resolve to 'c'.
  it('names the newest visible row for a phone reader, whose list is inverted', () => {
    const visible = [NATIVE_ORDER[1]!, NATIVE_ORDER[2]!]; // 'c' and 'b'
    expect(newestVisibleMessageId(TRANSCRIPT, visible)).toBe('c');
  });
});

describe('ReadCursorAdvancer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces a scroll into one write, at the row the reader stopped on', () => {
    const published: string[] = [];
    const advancer = new ReadCursorAdvancer((id) => published.push(id));

    // A scroll reports viewability many times over; the rows swept past on the
    // way were never read.
    advancer.observe(TRANSCRIPT, [TRANSCRIPT[0]!]);
    vi.advanceTimersByTime(100);
    advancer.observe(TRANSCRIPT, [TRANSCRIPT[1]!]);
    vi.advanceTimersByTime(100);
    advancer.observe(TRANSCRIPT, [TRANSCRIPT[2]!]);
    expect(published).toEqual([]);

    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);
    expect(published).toEqual(['c']);
  });

  it('never moves the boundary backwards when the reader scrolls up', () => {
    const published: string[] = [];
    const advancer = new ReadCursorAdvancer((id) => published.push(id));

    advancer.observe(TRANSCRIPT, [TRANSCRIPT[2]!]);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);
    advancer.observe(TRANSCRIPT, [TRANSCRIPT[0]!]);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);

    expect(published).toEqual(['c']);
  });

  it('writes nothing while the reader sits still on an already-published row', () => {
    const published: string[] = [];
    const advancer = new ReadCursorAdvancer((id) => published.push(id));

    advancer.observe(TRANSCRIPT, [TRANSCRIPT[1]!]);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);
    for (let report = 0; report < 5; report += 1) {
      advancer.observe(TRANSCRIPT, [TRANSCRIPT[1]!]);
      vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);
    }

    expect(published).toEqual(['b']);
  });

  it('keeps advancing when older history shifts every row down', () => {
    const published: string[] = [];
    const advancer = new ReadCursorAdvancer((id) => published.push(id));

    advancer.observe(TRANSCRIPT, [TRANSCRIPT[1]!]);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);

    // 'b' now sits at index 3 rather than 1. The comparison resolves both ids
    // against the SAME transcript, so the shift changes nothing.
    const older = [row('x'), row('y'), ...TRANSCRIPT];
    advancer.observe(older, [older[4]!]);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);

    expect(published).toEqual(['b', 'c']);
  });

  it('publishes what was seen when the visit ends before the debounce fires', () => {
    const published: string[] = [];
    const advancer = new ReadCursorAdvancer((id) => published.push(id));

    advancer.observe(TRANSCRIPT, [TRANSCRIPT[2]!]);
    advancer.flush();

    expect(published).toEqual(['c']);
  });

  it('drops the pending write when the Room changes out from under it', () => {
    const published: string[] = [];
    const advancer = new ReadCursorAdvancer((id) => published.push(id));

    advancer.observe(TRANSCRIPT, [TRANSCRIPT[2]!]);
    advancer.cancel();
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);

    expect(published).toEqual([]);
  });

  // Reproduction NATIVE-INVERTED-CURSOR, through the advancer. A phone reader
  // scrolling UP the transcript published each older row as if it were
  // progress, dragging their read mark backwards over mail they had not read.
  it('holds the boundary when a phone reader scrolls back up their inverted list', () => {
    const published: string[] = [];
    const advancer = new ReadCursorAdvancer((id) => published.push(id));

    // Sitting on 'c' — the reader's viewport, reported from the inverted list.
    advancer.observe(TRANSCRIPT, [NATIVE_ORDER[1]!]);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);
    expect(published).toEqual(['c']);

    // Scrolling back up to 'b', then 'a'. Older rows, never progress.
    advancer.observe(TRANSCRIPT, [NATIVE_ORDER[2]!]);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);
    advancer.observe(TRANSCRIPT, [NATIVE_ORDER[3]!]);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);
    expect(published).toEqual(['c']);

    // Back down past where they were: that IS progress.
    advancer.observe(TRANSCRIPT, [NATIVE_ORDER[0]!]);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);
    expect(published).toEqual(['c', 'd']);
  });

  it('stops reading once the reader has declared something unread', () => {
    const published: string[] = [];
    const advancer = new ReadCursorAdvancer((id) => published.push(id));

    advancer.observe(TRANSCRIPT, [TRANSCRIPT[1]!]);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);
    expect(published).toEqual(['b']);

    // Mark-unread. The viewport is still looking at the very rows it just
    // declared unread, and must not read them straight back.
    advancer.suspend();
    advancer.observe(TRANSCRIPT, [TRANSCRIPT[3]!]);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS * 4);
    expect(published).toEqual(['b']);

    // A fresh visit re-arms it.
    advancer.resume();
    advancer.observe(TRANSCRIPT, [TRANSCRIPT[3]!]);
    vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS);
    expect(published).toEqual(['b', 'd']);
  });
});
