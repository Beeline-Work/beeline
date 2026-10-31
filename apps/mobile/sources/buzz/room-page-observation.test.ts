import { expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ request }) }));
import { reportRoomPageObservation } from './room-page-observation';
it('defers successful observations until draw and reports failed reads without waiting for a Room', async () => {
  await reportRoomPageObservation(123, false);
  expect(request).toHaveBeenLastCalledWith('reportPageLoad', { durationMs: 123, failed: false }, { timeoutMs: 5_000, afterRoomDraw: true });
  request.mockRejectedValueOnce(new Error('offline'));
  await expect(reportRoomPageObservation(456, true)).resolves.toBeUndefined();
  expect(request).toHaveBeenLastCalledWith('reportPageLoad', { durationMs: 456, failed: true }, { timeoutMs: 5_000, afterRoomDraw: false });
});
