import { afterEach, expect, it, vi } from 'vitest';
import { beginNetworkResponseTiming } from './network-response-timing';

afterEach(() => vi.unstubAllGlobals());

it('keeps response arrival and JS handling separate when JS is delayed', () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(10);
  let records: unknown[] = [];
  const disconnect = vi.fn();
  class Observer {
    static supportedEntryTypes = ['resource'];
    observe() {}
    takeRecords() { return records; }
    disconnect = disconnect;
  }
  vi.stubGlobal('PerformanceObserver', Observer);
  const finish = beginNetworkResponseTiming('https://test/room');
  records = [{ name: 'https://test/room', fetchStart: 12, responseStart: 42, responseEnd: 48 }];
  now.mockReturnValue(248);
  const timing = finish()!;
  expect(timing.responseReceivedMs - timing.requestStartMs).toBe(30);
  expect(timing.jsHandledMs - timing.responseCompletedMs).toBe(200);
  expect(timing).toEqual({ requestStartMs: 12, responseReceivedMs: 42, responseCompletedMs: 48, jsHandledMs: 248 });
  expect(disconnect).toHaveBeenCalledOnce();
  now.mockRestore();
});

it('does not substitute callback time when native timestamps are unavailable', () => {
  vi.stubGlobal('PerformanceObserver', undefined);
  expect(beginNetworkResponseTiming('https://test/room')()).toBeNull();
});
