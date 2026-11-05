import type { DaemonApiClient } from './daemon-api-client.js';

/** A failed intake waits for registration, then reads once on that socket. */
export class RoomSupervisor {
  constructor(private readonly api: Pick<DaemonApiClient, 'onLiveOpen'>) {}

  async supervise(label: string, signal: AbortSignal | undefined, run: (progress: () => void) => Promise<void>): Promise<void> {
    while (!signal?.aborted) {
      try {
        await run(() => undefined);
        return;
      } catch (error) {
        if (signal?.aborted) return;
        console.error(`[thin-core] ${label} intake failed; awaiting registration:`, error);
        await new Promise<void>(resolve => {
          const done = () => {
            off();
            signal?.removeEventListener('abort', done);
            resolve();
          };
          const off = this.api.onLiveOpen(done);
          signal?.addEventListener('abort', done, { once: true });
          if (signal?.aborted) done();
        });
      }
    }
  }
}
