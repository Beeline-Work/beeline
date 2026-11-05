import type { DaemonApiClient } from './daemon-api-client.js';

/** A failed intake reconnects, then reads again on the authenticated socket. */
export class RoomSupervisor {
  constructor(private readonly api: Pick<DaemonApiClient, 'link' | 'onLiveOpen'>) {}

  async supervise(label: string, signal: AbortSignal | undefined, run: (progress: () => void) => Promise<void>): Promise<void> {
    while (!signal?.aborted) {
      try {
        await run(() => undefined);
        return;
      } catch (error) {
        if (signal?.aborted) return;
        console.error(`[thin-core] ${label} intake failed; reconnecting:`, error);
        await new Promise<void>(resolve => {
          const done = () => {
            off();
            signal?.removeEventListener('abort', done);
            resolve();
          };
          const off = this.api.onLiveOpen(done);
          signal?.addEventListener('abort', done, { once: true });
          if (signal?.aborted) done();
          // Other intakes may already have replaced this shared transport.
          else if (this.api.link.state !== 'connecting') this.api.link.reconnectNow();
        });
      }
    }
  }
}
