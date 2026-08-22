import {
  launchRuntimeDaemon,
  runtimeDaemonPid,
  stopRuntimeDaemon,
} from './runtime.js';

/**
 * How long a restart waits for the running daemon to finish its graceful
 * drain before giving up. SIGTERM asks the daemon to stop; it finishes any
 * in-flight agent turn first (supervisor `stopAll` → `Body.dispose` awaits
 * every running task), exactly as the self-update busy gate never interrupts
 * work. The budget mirrors self-update's idle wait; if the daemon is still
 * alive past it, the restart fails loudly and leaves the daemon running —
 * nothing is ever force-killed mid-turn.
 */
export const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 30 * 60_000;

/**
 * How often a long drain reports that the restart is still waiting (the wait
 * itself is healthy — see `stopRuntimeDaemon`'s `onWait`).
 */
const RESTART_WAIT_REPORT_INTERVAL_MS = 30_000;

export interface StartRuntimeDependencies {
  readPid: typeof runtimeDaemonPid;
  stop: typeof stopRuntimeDaemon;
  launch: typeof launchRuntimeDaemon;
  log: (message: string) => void;
}

const defaults: StartRuntimeDependencies = {
  readPid: runtimeDaemonPid,
  stop: stopRuntimeDaemon,
  launch: launchRuntimeDaemon,
  log: console.log,
};

/**
 * Launch one stored runtime daemon — restarting it first when it is already
 * running.
 *
 * `beeline start`'s documented contract is "restart this repo's (or host's)
 * durable agent", and it now means it: a running daemon is stopped (graceful
 * drain, never interrupting an in-flight turn) and a replacement is launched
 * through the same `launchRuntimeDaemon` handover the self-update path uses.
 * There is deliberately no silent "already running" early return left — that
 * behaviour made the documented restart path a no-op.
 */
export async function startStoredRuntime(
  configPath: string,
  opts: {
    /** Drain budget override (tests). Default `DEFAULT_RESTART_DRAIN_TIMEOUT_MS`. */
    drainTimeoutMs?: number;
    report?: (message: string) => void;
  } = {},
  dependencyOverrides: Partial<StartRuntimeDependencies> = {},
): Promise<number> {
  const deps = { ...defaults, ...dependencyOverrides };
  const report = opts.report ?? deps.log;
  const existingPid = await deps.readPid(configPath);
  if (existingPid) {
    report(`[buzz] agent daemon is running (pid ${existingPid}); restarting it`);
    let lastWaitReportAt = Date.now();
    const stoppedPid = await deps.stop(configPath, {
      timeoutMs: opts.drainTimeoutMs ?? DEFAULT_RESTART_DRAIN_TIMEOUT_MS,
      onWait: (pid) => {
        if (Date.now() - lastWaitReportAt < RESTART_WAIT_REPORT_INTERVAL_MS) return;
        lastWaitReportAt = Date.now();
        report(
          `[buzz] waiting for agent ${pid} to finish its in-flight work before stopping it…`,
        );
      },
    });
    if (stoppedPid) report(`[buzz] stopped previous daemon (pid ${stoppedPid})`);
  }
  const pid = await deps.launch(configPath);
  report(`[buzz] agent daemon ${existingPid ? 'restarted' : 'started'} (pid ${pid})`);
  return pid;
}
