import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from './runtime-config';

/** One content-free observation after a real Room frame or failed read. */
export async function reportRoomPageObservation(durationMs: number, failed: boolean): Promise<void> {
  try {
    await monolithSession.fetch(
      `${getBuzzRuntimeConfig().monolithUrl}/v1/phone/observations/page-load`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ durationMs, failed }),
      },
      { timeoutMs: 5_000 },
    );
  } catch {
    // Metrics never gate navigation or paint.
  }
}
