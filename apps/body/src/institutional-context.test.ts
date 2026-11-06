import { describe, expect, it, vi } from 'vitest';
import {
  awaitInstitutionalContext, EMPTY_INSTITUTIONAL_CONTEXT,
  INSTITUTIONAL_CONTEXT_MISSED_TEXT, startInstitutionalContextFetch,
} from './institutional-context.js';

describe('institutional context fetch', () => {
  it('starts immediately and handles rejection even when a cancelled turn never reads it', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('unavailable'));
    const catchSpy = vi.spyOn(Promise.prototype, 'catch');
    try {
      const fetch = startInstitutionalContextFetch({execute} as never, 'room');
      expect(execute).toHaveBeenCalledWith('getInstitutionalContext', {roomId:'room'});
      expect(catchSpy.mock.instances).toContain(fetch.promise);
    } finally { catchSpy.mockRestore(); }
    await Promise.resolve();
  });

  it('waits for completion across the former snapshot deadline', async () => {
    let complete!:(snapshot:typeof EMPTY_INSTITUTIONAL_CONTEXT)=>void;
    const execute = vi.fn(() => new Promise<typeof EMPTY_INSTITUTIONAL_CONTEXT>(resolve => {complete=resolve;}));
    const fetch = startInstitutionalContextFetch({execute} as never, 'room');
    let settled=false;
    const result=awaitInstitutionalContext(fetch).then(value=>{settled=true;return value;});
    vi.useFakeTimers();
    try { await vi.advanceTimersByTimeAsync(60_000); expect(settled).toBe(false); }
    finally { vi.useRealTimers(); }
    const snapshot={...EMPTY_INSTITUTIONAL_CONTEXT,text:'memory after reconnect'};
    complete(snapshot);
    await expect(result).resolves.toEqual({...snapshot,outcome:'served'});
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an empty snapshot from a failed read', async () => {
    const fetch=startInstitutionalContextFetch({execute:vi.fn().mockResolvedValue(EMPTY_INSTITUTIONAL_CONTEXT)} as never,'room');
    await expect(awaitInstitutionalContext(fetch)).resolves.toEqual({...EMPTY_INSTITUTIONAL_CONTEXT,outcome:'empty'});
    const log=vi.fn();
    const failed=startInstitutionalContextFetch({execute:vi.fn().mockRejectedValue(new Error('database unavailable'))} as never,'room');
    await expect(awaitInstitutionalContext(failed,log)).resolves.toEqual({...EMPTY_INSTITUTIONAL_CONTEXT,text:INSTITUTIONAL_CONTEXT_MISSED_TEXT,outcome:'timed-out'});
    expect(log).toHaveBeenCalledWith('institutional context unavailable: database unavailable');
  });

  it('does not request an explicitly disabled context lane', async () => {
    const execute=vi.fn();
    await expect(awaitInstitutionalContext(startInstitutionalContextFetch({execute} as never,'room',false)))
      .resolves.toEqual({...EMPTY_INSTITUTIONAL_CONTEXT,outcome:'empty'});
    expect(execute).not.toHaveBeenCalled();
  });
});
