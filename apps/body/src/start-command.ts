import { basename, dirname } from 'node:path';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { formatAgentCommand } from './agent-command.js';
import { ensureMachineHelper } from './helper-service.js';
import {
  findAgentRuntimeConfigPaths,
  findRuntimeConfigPaths,
  readRuntimeRecord,
  runtimeAgentCommand,
  runtimeDaemonPid,
  selectRuntimeConfigPaths,
  setAgentStopped,
  startMachineHelper,
} from './runtime.js';
import { runUpdateCommand } from './self-update-cli.js';

export type AgentStartStatus = 'started' | 'already-running' | 'failed';

export interface AgentStartOutcome {
  status: Exclude<AgentStartStatus, 'failed'>;
  pid: number;
}

export interface AgentStartReport {
  id: string;
  path: string;
  status: AgentStartStatus;
  pid?: number;
  reason?: string;
}

export interface StartRuntimeDependencies {
  readPid: typeof runtimeDaemonPid;
  /** Start the machine helper, or have the running one pick this runtime up. */
  launch: (configPath: string) => Promise<number>;
  log: (message: string) => void;
}

const startDefaults: StartRuntimeDependencies = {
  readPid: runtimeDaemonPid,
  launch: async () => (await startMachineHelper()).pid,
  log: console.log,
};

export interface StartCommandDependencies {
  updateBundle: () => Promise<void>;
  startOne: (
    configPath: string,
    spinnerHandle?: ReturnType<typeof clack.spinner>,
  ) => Promise<AgentStartOutcome>;
  log: (message: string) => void;
}

function defaultUpdateBundle(): Promise<void> {
  return runUpdateCommand([]);
}

/**
 * Have the machine helper host one stored runtime when nothing serves it yet.
 * A runtime the helper already serves is a no-op.
 */
export async function startStoredRuntime(
  configPath: string,
  opts: {
    report?: (message: string) => void;
  } = {},
  dependencyOverrides: Partial<StartRuntimeDependencies> = {},
): Promise<AgentStartOutcome> {
  const deps = { ...startDefaults, ...dependencyOverrides };
  const report = opts.report ?? deps.log;
  const existingPid = await deps.readPid(configPath);
  if (existingPid) {
    report(`[beeline] agent already running (pid ${existingPid})`);
    return { status: 'already-running', pid: existingPid };
  }
  const pid = await deps.launch(configPath);
  report(`[beeline] agent started in the machine helper (pid ${pid})`);
  return { status: 'started', pid };
}

export function agentStartId(configPath: string): string {
  return basename(dirname(configPath));
}

async function startRuntime(
  configPath: string,
  spinnerHandle?: ReturnType<typeof clack.spinner>,
): Promise<AgentStartOutcome> {
  const report = (text: string) =>
    spinnerHandle ? spinnerHandle.message(text) : console.log(text);
  const runtime = await readRuntimeRecord(configPath);
  const selectedAgent = runtimeAgentCommand(runtime);
  report(`[body] agent ${runtime.agent.publicKey} binary: ${formatAgentCommand(selectedAgent)}`);
  // `start` undoes `stop`: the helper hosts this agent again on its next scan.
  await setAgentStopped(configPath, false);
  const existingPid = await runtimeDaemonPid(configPath);
  if (existingPid) {
    // Already served. The Squire elector and the machine helper unit are
    // still converged here: a host on per-agent units migrates on this call.
    await ensureMachineHelper({ report }).catch((error) =>
      report(`[beeline] machine helper not converged: ${error instanceof Error ? error.message : String(error)}`));
    report(`[beeline] agent already running (pid ${existingPid})`);
    return { status: 'already-running', pid: existingPid };
  }
  const helper = await ensureMachineHelper({ report });
  report(`[beeline] agent hosted by the machine helper, supervised by ${helper.supervisor} (pid ${helper.pid})`);
  return { status: 'started', pid: helper.pid };
}

function formatAgentReport(report: AgentStartReport): string {
  if (report.status === 'failed') {
    return `[beeline] ${report.id}: failed (${report.reason ?? 'unknown error'})`;
  }
  const label = report.status === 'already-running' ? 'already running' : 'started';
  return `[beeline] ${report.id}: ${label} (pid ${report.pid})`;
}

/** Select and start the runtimes addressed by one `beeline start` invocation. */
export async function runStartCommand(
  args: string[],
  interactiveUi: boolean,
  dependencyOverrides: Partial<StartCommandDependencies> = {},
): Promise<AgentStartReport[]> {
  const deps: StartCommandDependencies = {
    updateBundle: defaultUpdateBundle,
    startOne: startRuntime,
    log: console.log,
    ...dependencyOverrides,
  };
  const allFlag = args.includes('--all');
  const agentFlag = args.indexOf('--agent');
  const flagPubkey = agentFlag >= 0 ? args[agentFlag + 1] : undefined;
  if (agentFlag >= 0 && !flagPubkey) throw new Error('--agent requires an agent pubkey');
  const positionalPubkey = args
    .slice(1)
    .find((token) => !token.startsWith('--') && token !== flagPubkey);
  const requestedPubkey = flagPubkey ?? positionalPubkey;
  try {
    await deps.updateBundle();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log(`[beeline] helper update failed (${reason}); starting agents on the current bundle`);
  }
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
  const reports: AgentStartReport[] = [];
  for (const path of unique) {
    const id = agentStartId(path);
    const spinnerHandle = interactiveUi ? clack.spinner() : undefined;
    spinnerHandle?.start(`Starting ${dirname(path)}…`);
    try {
      const outcome = await deps.startOne(path, spinnerHandle);
      const report: AgentStartReport = { id, path, ...outcome };
      reports.push(report);
      const line = formatAgentReport(report);
      if (spinnerHandle) spinnerHandle.stop(pc.green(line));
      else deps.log(line);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const report: AgentStartReport = { id, path, status: 'failed', reason };
      reports.push(report);
      const line = formatAgentReport(report);
      if (spinnerHandle) spinnerHandle.stop(pc.red(line));
      else deps.log(line);
    }
  }
  const failed = reports.filter((report) => report.status === 'failed').length;
  if (interactiveUi) {
    clack.outro(
      failed > 0
        ? pc.red(`${failed} of ${reports.length} agents failed.`)
        : pc.green(unique.length > 1 ? 'All agents started.' : 'Done.'),
    );
  }
  if (failed > 0) {
    throw new Error(`failed to start ${failed} of ${reports.length} agent(s)`);
  }
  return reports;
}
