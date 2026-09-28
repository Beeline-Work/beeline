import { EventEmitter } from 'node:events';

export const DAEMON_HARD_STOP_MS = 75_000;

/** Abort intake immediately; keep a last-resort exit below the service stop ceiling. */
export function installDaemonStopSignals(
  controller: AbortController,
  options: {
    emitter?: EventEmitter;
    hardExit?: () => void;
    timeoutMs?: number;
  } = {},
): () => void {
  const emitter = options.emitter ?? process;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      console.error('[thin-core] shutdown deadline reached; exiting old helper');
      (options.hardExit ?? (() => process.exit(0)))();
    }, options.timeoutMs ?? DAEMON_HARD_STOP_MS);
    controller.abort();
  };
  emitter.once('SIGINT', stop);
  emitter.once('SIGTERM', stop);
  return () => {
    if (timer) clearTimeout(timer);
    emitter.removeListener('SIGINT', stop);
    emitter.removeListener('SIGTERM', stop);
  };
}
