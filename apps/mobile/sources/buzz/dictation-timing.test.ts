import { afterEach, expect, it, vi } from 'vitest';
import { createDictationTiming, markDictatedMessageAccepted, trackDictatedMessage } from './dictation-timing';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('logs only stages and elapsed times; acceptance is correlated once without logging event IDs', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  const timing = createDictationTiming();
  timing.mark('send_tapped');
  trackDictatedMessage('private-event-id', timing);
  clock.mockReturnValue(350);
  markDictatedMessageAccepted('another-id');
  expect(log).toHaveBeenCalledTimes(1);
  markDictatedMessageAccepted('private-event-id');
  markDictatedMessageAccepted('private-event-id');
  expect(log).toHaveBeenCalledTimes(2);
  const first = JSON.parse(log.mock.calls[0]![1]);
  expect(JSON.parse(log.mock.calls[1]![1])).toEqual({ take: first.take, stage: 'server_accepted', elapsedMs: 250 });
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-event-id');
});
it('expires disconnected sends so a later acknowledgement cannot count as a timely send', () => {
  vi.useFakeTimers();
  const mark = vi.fn();
  trackDictatedMessage('expired', { mark });
  vi.advanceTimersByTime(120_001);
  markDictatedMessageAccepted('expired');
  expect(mark).not.toHaveBeenCalled();
});
