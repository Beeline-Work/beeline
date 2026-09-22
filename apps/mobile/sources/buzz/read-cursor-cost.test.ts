import { describe, expect, it, vi } from 'vitest';
import { ReadCursorAdvancer, READ_CURSOR_DEBOUNCE_MS } from './read-cursor-advance';
import type { ChatDisplayMessage } from './room-view-presentation';

/**
 * Measurement suite for the fanout performance audit, not a product contract.
 * The viewport read cursor (#1609) put a server write behind scroll, which is
 * the hottest interaction on this surface, so the callback body, the debounce,
 * and the write's placement relative to the interaction path all land inside
 * the audit's unproven 150 ms interaction gap.
 */

/** One frame at 60 Hz. The callback body runs inside this. */
const FRAME_BUDGET_MS = 1000 / 60;

function corpus(count: number): ChatDisplayMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const base: ChatDisplayMessage = {
      id: `m-${index}`,
      text: `row ${index}`,
      isUser: index % 5 === 0,
      timestamp: 1_700_000_000 + index,
    } as ChatDisplayMessage;
    // Real transcripts fold: roughly every sixth row carries folded ids and
    // every eleventh carries relay reports, which is what makes
    // `messageBoundaryIds` allocate per row it visits.
    if (index % 6 === 0) {
      (base as { foldedIds?: string[] }).foldedIds = [`m-${index}`, `f-${index}-a`, `f-${index}-b`];
    }
    if (index % 11 === 0) {
      (base as { relayReports?: { id: string }[] }).relayReports = [{ id: `r-${index}` }];
    }
    return base;
  });
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function report(label: string, samples: number[]): { p50: number; p95: number } {
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  console.log(
    `${label.padEnd(46)} p50 ${p50.toFixed(3).padStart(8)} ms   p95 ${p95.toFixed(3).padStart(8)} ms   n=${samples.length}`,
  );
  return { p50, p95 };
}

const VISIBLE_ROWS = 12;

describe('A. cost of the read-cursor work inside one viewability callback', () => {
  for (const size of [200, 1_000, 5_000]) {
    it(`scrolling reader, ${size}-message transcript`, () => {
      const chronological = corpus(size);
      const advancer = new ReadCursorAdvancer(() => undefined, 10_000);
      const samples: number[] = [];
      // A reader scrolling FORWARD: every report names a later row, so nothing
      // short-circuits and the full body runs, exactly as it does under a flick.
      for (let start = 0; start + VISIBLE_ROWS < size; start += 1) {
        const visible = chronological.slice(start, start + VISIBLE_ROWS);
        const began = performance.now();
        advancer.observe(chronological, visible);
        samples.push(performance.now() - began);
      }
      const { p95 } = report(`A-scroll  n=${size}`, samples);
      expect(p95).toBeGreaterThanOrEqual(0);
    });

    it(`stationary reader, ${size}-message transcript`, () => {
      const chronological = corpus(size);
      const advancer = new ReadCursorAdvancer(() => undefined, 10_000);
      // Put the cursor at the tail first so the repeat reports short-circuit
      // on `#published === candidate` the way a reader sitting still does.
      const visible = chronological.slice(size - VISIBLE_ROWS);
      advancer.observe(chronological, visible);
      vi.useFakeTimers();
      const armed = new ReadCursorAdvancer(() => undefined, 1);
      armed.observe(chronological, visible);
      vi.advanceTimersByTime(5);
      vi.useRealTimers();
      const samples: number[] = [];
      for (let iteration = 0; iteration < 400; iteration += 1) {
        const began = performance.now();
        armed.observe(chronological, visible);
        samples.push(performance.now() - began);
      }
      report(`A-still   n=${size}`, samples);
      expect(samples.length).toBe(400);
    });
  }

  it('reports the frame budget the body has to fit inside', () => {
    console.log(`frame budget at 60 Hz: ${FRAME_BUDGET_MS.toFixed(2)} ms`);
    expect(FRAME_BUDGET_MS).toBeGreaterThan(0);
  });
});

describe('B. debounce behaviour under a fast flick', () => {
  it('a three-second flick with no rest writes nothing until the reader stops', () => {
    vi.useFakeTimers();
    try {
      const chronological = corpus(5_000);
      const writes: string[] = [];
      const advancer = new ReadCursorAdvancer((id) => writes.push(id));
      // RN reports viewability on its own cadence; 40 ms is roughly a frame
      // batch under a sustained drag.
      let start = 0;
      for (let elapsed = 0; elapsed < 3_000; elapsed += 40) {
        advancer.observe(chronological, chronological.slice(start, start + VISIBLE_ROWS));
        start += 20;
        vi.advanceTimersByTime(40);
      }
      const duringFlick = writes.length;
      vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS + 50);
      console.log(
        `B-flick   3000 ms sustained scroll, 75 viewability reports -> writes during flick ${duringFlick}, writes at rest ${writes.length}`,
      );
      expect(duringFlick).toBe(0);
      expect(writes.length).toBe(1);
      expect(writes[0]).toBe(`m-${start - 20 + VISIBLE_ROWS - 1}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a flick that rests twice mid-scroll writes once per rest', () => {
    vi.useFakeTimers();
    try {
      const chronological = corpus(5_000);
      const writes: string[] = [];
      const advancer = new ReadCursorAdvancer((id) => writes.push(id));
      let start = 0;
      for (let leg = 0; leg < 3; leg += 1) {
        for (let elapsed = 0; elapsed < 600; elapsed += 40) {
          advancer.observe(chronological, chronological.slice(start, start + VISIBLE_ROWS));
          start += 20;
          vi.advanceTimersByTime(40);
        }
        vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS + 50);
      }
      console.log(`B-rests   three legs with a rest after each -> writes ${writes.length}`);
      expect(writes.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scrolling BACK up the transcript writes nothing at all', () => {
    vi.useFakeTimers();
    try {
      const chronological = corpus(5_000);
      const writes: string[] = [];
      const advancer = new ReadCursorAdvancer((id) => writes.push(id));
      advancer.observe(chronological, chronological.slice(4_000, 4_000 + VISIBLE_ROWS));
      vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS + 50);
      const afterForward = writes.length;
      for (let start = 3_900; start > 0; start -= 20) {
        advancer.observe(chronological, chronological.slice(start, start + VISIBLE_ROWS));
        vi.advanceTimersByTime(40);
      }
      vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS + 50);
      console.log(
        `B-back    195 upward reports after one forward write -> total writes ${writes.length} (forward ${afterForward})`,
      );
      expect(writes.length).toBe(afterForward);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('C. the write relative to the interaction path', () => {
  it('a publish that never settles does not enter the callback body', async () => {
    vi.useFakeTimers();
    let settle: (() => void) | null = null;
    const publishes: string[] = [];
    try {
      const chronological = corpus(5_000);
      const advancer = new ReadCursorAdvancer((id) => {
        publishes.push(id);
        // Stand in for `markRead`'s promise: the surface's publish closure does
        // `void client.markRead(...).catch(...)` and never awaits it.
        void new Promise<void>((resolve) => {
          settle = resolve;
        });
      });
      advancer.observe(chronological, chronological.slice(100, 100 + VISIBLE_ROWS));
      vi.advanceTimersByTime(READ_CURSOR_DEBOUNCE_MS + 10);
      expect(publishes.length).toBe(1);
      // The next callback runs to completion with the previous write still in
      // flight — nothing in the advancer is holding a promise.
      const began = performance.now();
      advancer.observe(chronological, chronological.slice(200, 200 + VISIBLE_ROWS));
      const cost = performance.now() - began;
      console.log(
        `C-inflight next callback with an unsettled write outstanding: ${cost.toFixed(3)} ms`,
      );
      expect(settle).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
