import { describe, expect, it, vi } from 'vitest';
import {
  awaitInstitutionalContext,
  EMPTY_INSTITUTIONAL_CONTEXT,
  INSTITUTIONAL_CONTEXT_MISSED_TEXT,
  startInstitutionalContextFetch,
} from './institutional-context.js';

describe('institutional context fetch', () => {
  it('starts the request immediately, before anything awaits it', () => {
    const execute = vi.fn().mockResolvedValue(EMPTY_INSTITUTIONAL_CONTEXT);
    startInstitutionalContextFetch({ execute } as never, 'room-1');
    expect(execute).toHaveBeenCalledWith('getInstitutionalContext', { roomId: 'room-1' });
  });

  it('marks the started promise handled immediately, so a turn cancelled or superseded before reading the result never produces an unhandled rejection', async () => {
    const catchSpy = vi.spyOn(Promise.prototype, 'catch');
    try {
      const fetch = startInstitutionalContextFetch(
        { execute: vi.fn().mockRejectedValue(new Error('database unavailable')) } as never,
        'room-1',
      );
      // A handler must already be attached to `fetch.promise` itself (not a
      // downstream derived promise) before this call returns — nothing else
      // is ever going to read this handle in the cancelled/superseded case.
      expect(catchSpy.mock.instances).toContain(fetch.promise);
    } finally {
      catchSpy.mockRestore();
    }
    // The real rejection is still observable by a caller that does read it later.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('serves a snapshot that resolves within the remaining budget', async () => {
    const snapshot = {
      snapshotRevision: 7,
      text: 'quoted memory',
      itemIds: ['item-1'],
      totalBytes: 13,
      omitted: {},
    };
    const execute = vi.fn().mockResolvedValue(snapshot);
    const fetch = startInstitutionalContextFetch({ execute } as never, 'room-1', true, () => 0);
    await expect(awaitInstitutionalContext(fetch, vi.fn(), 200, () => 0)).resolves.toEqual({
      ...snapshot,
      outcome: 'served',
    });
  });

  it('reports a legitimately empty snapshot as empty, not served', async () => {
    const execute = vi.fn().mockResolvedValue(EMPTY_INSTITUTIONAL_CONTEXT);
    const fetch = startInstitutionalContextFetch({ execute } as never, 'room-1', true, () => 0);
    await expect(awaitInstitutionalContext(fetch, vi.fn(), 200, () => 0)).resolves.toEqual({
      ...EMPTY_INSTITUTIONAL_CONTEXT,
      outcome: 'empty',
    });
  });

  it('waits only for the budget remaining since the fetch started, not a fresh budget from the await call', async () => {
    // The fetch was kicked off 150ms ago (elsewhere: alongside activation);
    // only 50ms of the 200ms budget is left by the time anything awaits it.
    let elapsed = 150;
    const now = () => elapsed;
    const execute = vi.fn(() => new Promise(() => undefined)); // never resolves
    const fetch = startInstitutionalContextFetch({ execute } as never, 'room-1', true, () => 0);
    const failures: string[] = [];
    vi.useFakeTimers();
    try {
      const result = awaitInstitutionalContext(fetch, (message) => failures.push(message), 200, now);
      // A naive implementation that re-armed a fresh 200ms from this call
      // would still be waiting; the fix must give up after the 50ms actually
      // left in the original budget.
      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toEqual({
        ...EMPTY_INSTITUTIONAL_CONTEXT,
        text: INSTITUTIONAL_CONTEXT_MISSED_TEXT,
        outcome: 'timed-out',
      });
    } finally {
      vi.useRealTimers();
    }
    expect(failures).toEqual(['institutional context unavailable: institutional context timed out']);
  });

  it('uses a snapshot already resolved by await time even though no budget remained', async () => {
    // Activation ran long enough that the whole 200ms budget is already
    // spent by the time the turn asks for the result — but the real fetch,
    // started alongside activation, finished before that moment anyway.
    const snapshot = {
      snapshotRevision: 3,
      text: 'settled before it was needed',
      itemIds: ['item-9'],
      totalBytes: 30,
      omitted: {},
    };
    const execute = vi.fn().mockResolvedValue(snapshot);
    const fetch = startInstitutionalContextFetch({ execute } as never, 'room-1', true, () => 0);
    await fetch.promise; // real network call already settled
    const result = await awaitInstitutionalContext(fetch, vi.fn(), 200, () => 300);
    expect(result).toEqual({ ...snapshot, outcome: 'served' });
  });

  it('never returns silence on a genuine miss — the text names the miss instead of looking empty', async () => {
    const failures: string[] = [];
    const rejected = startInstitutionalContextFetch(
      { execute: vi.fn().mockRejectedValue(new Error('database unavailable')) } as never,
      'room-1',
      true,
      () => 0,
    );
    await expect(
      awaitInstitutionalContext(rejected, (message) => failures.push(message), 200, () => 0),
    ).resolves.toEqual({
      ...EMPTY_INSTITUTIONAL_CONTEXT,
      text: INSTITUTIONAL_CONTEXT_MISSED_TEXT,
      outcome: 'timed-out',
    });

    vi.useFakeTimers();
    try {
      const stuck = startInstitutionalContextFetch(
        { execute: vi.fn(() => new Promise(() => undefined)) } as never,
        'room-1',
        true,
        () => 0,
      );
      const result = awaitInstitutionalContext(
        stuck,
        (message) => failures.push(message),
        1,
        () => 0,
      );
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual({
        ...EMPTY_INSTITUTIONAL_CONTEXT,
        text: INSTITUTIONAL_CONTEXT_MISSED_TEXT,
        outcome: 'timed-out',
      });
    } finally {
      vi.useRealTimers();
    }
    expect(failures).toEqual([
      'institutional context unavailable: database unavailable',
      'institutional context unavailable: institutional context timed out',
    ]);
    // The text is never empty on a miss — an agent that only checks `text`
    // truthiness must see a reason, not silence indistinguishable from
    // "nothing was ever saved" (the recall-miss incident this guards against).
    expect(INSTITUTIONAL_CONTEXT_MISSED_TEXT.length).toBeGreaterThan(0);
  });

  it('fetches by default without any host flag', async () => {
    const execute = vi.fn().mockResolvedValue(EMPTY_INSTITUTIONAL_CONTEXT);
    const fetch = startInstitutionalContextFetch({ execute } as never, 'room-1');
    await expect(awaitInstitutionalContext(fetch)).resolves.toEqual({
      ...EMPTY_INSTITUTIONAL_CONTEXT,
      outcome: 'empty',
    });
    expect(execute).toHaveBeenCalledWith('getInstitutionalContext', { roomId: 'room-1' });
  });

  it('is off only when the live host flag is explicitly false', async () => {
    vi.stubEnv('BEELINE_INSTITUTIONAL_MEMORY_ENABLED', 'false');
    try {
      const execute = vi.fn();
      const fetch = startInstitutionalContextFetch({ execute } as never, 'room-1');
      await expect(awaitInstitutionalContext(fetch)).resolves.toEqual({
        ...EMPTY_INSTITUTIONAL_CONTEXT,
        outcome: 'empty',
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
