/** One committed source event admits one job; idle time admits nothing. */
export function startBackgroundWork(run: () => Promise<unknown>) {
  let stopped = false;
  let pending = false;
  let running: Promise<void> | undefined;
  const drain = () => {
    running = (async () => {
      while (pending) { pending = false; await run(); }
    })().catch(error => console.error('[background] event failed', error)).finally(() => {
      running = undefined;
      // A source event can arrive between the loop ending and this settlement.
      if (pending) drain();
    });
  };
  return {
    wake() { if (!stopped) { pending = true; if (!running) drain(); } },
    async stop() {
      stopped = true;
      // Events admitted before shutdown drain, including one received in flight.
      while (running) await running;
    },
  };
}
