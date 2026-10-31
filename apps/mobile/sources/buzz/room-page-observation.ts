import { sharedLiveConnection } from '@/sync/transport/live-connection';

/** One content-free observation after a real Room frame or failed read. */
export async function reportRoomPageObservation(
  durationMs: number,
  failed: boolean,
  network?: { requestToFirstByteMs: number; serverProcessingMs: number; jsResponseDelayMs?: number },
): Promise<void> {
  try {
    await sharedLiveConnection().request('reportPageLoad',
      { durationMs, failed, ...(network ? { network } : {}) },
      { timeoutMs: 5_000, afterRoomDraw: !failed },
    );
  } catch {
    // Metrics never gate navigation or paint.
  }
}
