import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/** One content-free observation after a real Room frame or failed read. */
export async function reportRoomPageObservation(
  durationMs: number,
  failed: boolean,
  network?: { requestToFirstByteMs: number; serverProcessingMs: number; jsResponseDelayMs?: number },
): Promise<void> {
  try {
    await monolithPhoneOperation('reportPageLoad',
      { durationMs, failed, ...(network ? { network } : {}) },
      { timeoutMs: 5_000, afterRoomDraw: !failed },
    );
  } catch {
    // Metrics never gate navigation or paint.
  }
}
