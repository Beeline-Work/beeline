import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoomHistoryOutline } from '@beeline/api-contract/phone';
import {
  nearestScrubberDay,
  scrubberBubble,
  scrubberHistory,
  scrubberPosition,
} from './transcript-scrubber';

const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  process.env.TZ = originalTz;
});

const id = (n: number) => n.toString(16).padStart(64, '0');
const at = (iso: string) => Date.parse(iso) / 1_000;

// 100 messages: 40 on 30 Aug, 30 on 1 Sep, 30 on 2 Sep.
const outline: RoomHistoryOutline = {
  roomId: '00000000-0000-4000-8000-000000000001',
  timeZone: 'UTC',
  total: 100,
  newest: { id: id(100), createdAt: at('2026-09-02T12:30:00Z') },
  days: [
    {
      day: '2026-08-30',
      count: 40,
      first: {
        id: id(1),
        createdAt: at('2026-08-30T08:05:00Z'),
        authorName: 'Ann',
        authorHandle: 'ann',
      },
    },
    {
      day: '2026-09-01',
      count: 30,
      first: {
        id: id(41),
        createdAt: at('2026-09-01T09:10:00Z'),
        authorName: 'Niglet',
        authorHandle: 'niglet',
      },
    },
    {
      day: '2026-09-02',
      count: 30,
      first: { id: id(71), createdAt: at('2026-09-02T12:00:00Z'), authorName: 'Bo' },
    },
  ],
};
const loaded = (from: number, to = 100) =>
  Array.from({ length: to - from + 1 }, (_, index) => id(from + index));

describe('transcript scrubber', () => {
  it('keeps the handle still when an older page loads above the reader', () => {
    // The tail page is loaded and the reader's oldest visible message is #75.
    const tail = scrubberHistory(outline, loaded(71));
    const before = scrubberPosition(tail, [id(75)]);
    // A page of thirty older messages pages in; the reader has not moved.
    const paged = scrubberHistory(outline, loaded(41));
    expect(scrubberPosition(paged, [id(75)])).toBe(before);
    expect(before).toBeCloseTo(25 / 99);
  });

  it('places one marker per day against the whole history, oldest at the top', () => {
    const { days, total } = scrubberHistory(outline, loaded(71));
    expect(total).toBe(100);
    expect(days.map((day) => [day.key, day.firstMessageId, day.messagesBack])).toEqual([
      ['2026-08-30', id(1), 99],
      ['2026-09-01', id(41), 59],
      ['2026-09-02', id(71), 29],
    ]);
    expect(days[0]!.position).toBe(1);
    expect(days.map((day) => day.monthStart)).toEqual([true, true, false]);
  });

  it('snaps to the nearest day and names its first message', () => {
    const { days } = scrubberHistory(outline, loaded(71));
    const day = nearestScrubberDay(days, 0.55)!;
    expect(day.key).toBe('2026-09-01');
    expect(scrubberBubble(day)).toEqual({
      date: 'TUE 1 SEP',
      detail: '09:10 · @niglet · 59 messages back',
    });
    expect(scrubberBubble(nearestScrubberDay(days, 0)!).detail).toBe(
      '12:00 · Bo · 29 messages back',
    );
  });

  it('keeps a marker for each local day the server cut, either side of an India midnight', () => {
    // 23:50 on 1 Sep and 00:15 on 2 Sep in India (UTC+5:30) share the 18:00Z
    // hour; the server cuts days in the reader's zone, so they are two days.
    process.env.TZ = 'Asia/Kolkata';
    try {
      const { days } = scrubberHistory(
        {
          roomId: outline.roomId,
          timeZone: 'Asia/Kolkata',
          total: 3,
          newest: { id: id(3), createdAt: at('2026-09-01T18:45:00Z') },
          days: [
            {
              day: '2026-09-01',
              count: 2,
              first: { id: id(1), createdAt: at('2026-09-01T18:20:00Z'), authorName: 'Ann' },
            },
            {
              day: '2026-09-02',
              count: 1,
              first: { id: id(3), createdAt: at('2026-09-01T18:45:00Z'), authorName: 'Bo' },
            },
          ],
        },
        [id(1), id(2), id(3)],
      );
      expect(days.map((day) => [day.key, day.firstMessageId, day.messagesBack])).toEqual([
        ['2026-09-01', id(1), 2],
        ['2026-09-02', id(3), 0],
      ]);
      expect(scrubberBubble(days[1]!)).toEqual({
        date: 'WED 2 SEP',
        detail: '00:15 · Bo · newest message',
      });
    } finally {
      process.env.TZ = 'UTC';
    }
  });

  it('reaches the oldest of more than twenty thousand days from the top of the rail', () => {
    const count = 20_001;
    const long: RoomHistoryOutline = {
      roomId: outline.roomId,
      timeZone: 'UTC',
      total: count,
      newest: { id: id(count), createdAt: at('2034-10-04T12:00:00Z') },
      days: Array.from({ length: count }, (_, index) => {
        const createdAt = at('1980-01-01T12:00:00Z') + index * 86_400;
        return {
          day: new Date(createdAt * 1_000).toISOString().slice(0, 10),
          count: 1,
          first: { id: id(index + 1), createdAt, authorName: 'Ann' },
        };
      }),
    };
    const { days } = scrubberHistory(long, [id(count)]);
    expect(days).toHaveLength(count);
    expect(nearestScrubberDay(days, 1)).toMatchObject({
      key: '1980-01-01',
      firstMessageId: id(1),
      messagesBack: count - 1,
    });
    expect(nearestScrubberDay(days, 0)?.key).toBe(long.days.at(-1)!.day);
  });

  it('counts messages that arrived after the outline was read', () => {
    const history = scrubberHistory(outline, [...loaded(71), id(101), id(102)]);
    expect(history.total).toBe(102);
    expect(scrubberPosition(history, [id(102)])).toBe(0);
  });
});
