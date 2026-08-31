import { dirname, resolve } from 'node:path';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { formatAgentCommand } from './agent-command.js';
import {
  findAgentRuntimeConfigPaths,
  findRuntimeConfigPaths,
  launchRuntimeDaemon,
  readRuntimeRecord,
  runtimeAgentCommand,
  runtimeDaemonPid,
  selectRuntimeConfigPaths,
  stopRuntimeDaemon,
} from './runtime.js';
import { beelineInstallLayout } from './self-update.js';
import { installAgentService } from './systemd.js';

export function stableBeelineEntrypoint(): string {
  const layout = beelineInstallLayout(process.env);
  return layout ? resolve(layout.binDir, 'beeline') : resolve(process.argv[1]!);
}

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
        report(`[buzz] waiting for agent ${pid} to finish its in-flight work before stopping it…`);
      },
    });
    if (stoppedPid) report(`[buzz] stopped previous daemon (pid ${stoppedPid})`);
  }
  const pid = await deps.launch(configPath);
  report(`[buzz] agent daemon ${existingPid ? 'restarted' : 'started'} (pid ${pid})`);
  return pid;
}

async function startRuntime(
  configPath: string,
  spinnerHandle?: ReturnType<typeof clack.spinner>,
): Promise<void> {
  const report = (text: string) =>
    spinnerHandle ? spinnerHandle.message(text) : console.log(text);
  const runtime = await readRuntimeRecord(configPath);
  const selectedAgent = runtimeAgentCommand(runtime);
  report(`[body] agent ${runtime.agent.publicKey} binary: ${formatAgentCommand(selectedAgent)}`);
  if (process.platform === 'linux' && process.env.BEELINE_SYSTEMD_USER !== '0') {
    const existingPid = await runtimeDaemonPid(configPath);
    if (existingPid) {
      report(`[buzz] agent daemon is running (pid ${existingPid}); draining it before supervision`);
      await stopRuntimeDaemon(configPath, { timeoutMs: 30 * 60_000 });
    }
    const pid = await installAgentService(runtime.agent.publicKey, {
      entrypoint: stableBeelineEntrypoint(),
    });
    report(`[buzz] agent daemon supervised by systemd (pid ${pid})`);
    return;
  }
  await startStoredRuntime(configPath, { report });
}

/** Select and start the runtimes addressed by one `beeline start` invocation. */
export async function runStartCommand(args: string[], interactiveUi: boolean): Promise<void> {
  const allFlag = args.includes('--all');
  const agentFlag = args.indexOf('--agent');
  const flagPubkey = agentFlag >= 0 ? args[agentFlag + 1] : undefined;
  if (agentFlag >= 0 && !flagPubkey) throw new Error('--agent requires an agent pubkey');
  const positionalPubkey = args
    .slice(1)
    .find((token) => !token.startsWith('--') && token !== flagPubkey);
  const requestedPubkey = flagPubkey ?? positionalPubkey;
  const { paths: unique } = await selectRuntimeConfigPaths({
    cwd: process.cwd(),
    all: allFlag,
    requestedPubkey,
    findHostRuntimes: (cwd) => findAgentRuntimeConfigPaths(process.env, cwd),
    findRepositoryRuntimes: findRuntimeConfigPaths,
    noRuntimeMessage: (hostScope) =>
      requestedPubkey
        ? `no paired agent runtime found for ${requestedPubkey}`
        : hostScope
          ? 'no paired agent runtime found on this host'
          : 'no paired agent runtime found in this repository',
    multipleRuntimeMessage:
      'multiple paired agents match that pubkey; pass the full agent pubkey shown by `beeline pair`',
  });
  if (interactiveUi) clack.intro(pc.bold('beeline start'));
  for (const path of unique) {
    if (!interactiveUi) {
      await startRuntime(path);
      continue;
    }
    const spinnerHandle = clack.spinner();
    spinnerHandle.start(`Starting ${dirname(path)}…`);
    try {
      await startRuntime(path, spinnerHandle);
      spinnerHandle.stop(pc.green('Started.'));
    } catch (error) {
      spinnerHandle.stop(pc.red('Failed.'));
      throw error;
    }
  }
  if (interactiveUi) {
    clack.outro(pc.green(unique.length > 1 ? 'All agents started.' : 'Done.'));
  }
}
