import {
  installLaunchdHelperService,
  installLaunchdTrustySquireBrokerService,
  launchdAgentLabel,
  reloadLaunchdHelperService,
} from './launchd.js';
import { defaultSupervisorRoot, runningHelperPid, startMachineHelper } from './runtime.js';
import {
  installHelperService,
  installTrustySquireBrokerService,
  reloadHelperService,
} from './systemd.js';

export type Supervisor = 'systemd' | 'launchd' | 'process';

/** Which service manager owns the machine helper on this host. */
export function supervisor(env: NodeJS.ProcessEnv = process.env): Supervisor {
  if (process.platform === 'linux' && env.BEELINE_SYSTEMD_USER !== '0') return 'systemd';
  if (process.platform === 'darwin' && env.BEELINE_LAUNCHD_USER !== '0') return 'launchd';
  return 'process';
}

/**
 * Make the machine's one helper process host every paired agent: install and
 * start it, or ask the running one to rescan. Agents it already serves keep
 * serving. Returns the helper's pid.
 */
export async function ensureMachineHelper(
  options: {
    env?: NodeJS.ProcessEnv;
    report?: (line: string) => void;
    /** The legacy per-agent job this process runs in, retired last. */
    selfAgent?: string;
  } = {},
): Promise<{ pid: number; supervisor: Supervisor }> {
  const env = options.env ?? process.env;
  const report = options.report ?? ((line: string) => console.warn(line));
  const kind = supervisor(env);
  if (kind === 'systemd') {
    await installTrustySquireBrokerService({ env }).catch((error) =>
      report(`[beeline] trusty-squire host broker not installed: ${
        error instanceof Error ? error.message : String(error)}`));
    return { pid: await installHelperService({ env }), supervisor: kind };
  }
  if (kind === 'launchd') {
    await installLaunchdTrustySquireBrokerService({ env }).catch((error) =>
      report(`[beeline] trusty-squire host broker not installed: ${
        error instanceof Error ? error.message : String(error)}`));
    return {
      pid: await installLaunchdHelperService({
        env, ...(options.selfAgent ? { selfLabel: launchdAgentLabel(options.selfAgent) } : {}),
      }),
      supervisor: kind,
    };
  }
  return { pid: (await startMachineHelper({ env })).pid, supervisor: kind };
}

/** Ask a running helper to rescan paired agents; a stopped helper stays stopped. */
export async function reloadMachineHelper(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const kind = supervisor(env);
  if (kind === 'systemd') return reloadHelperService();
  if (kind === 'launchd') return reloadLaunchdHelperService();
  const pid = await runningHelperPid(defaultSupervisorRoot(env));
  if (!pid) return false;
  process.kill(pid, 'SIGHUP');
  return true;
}
