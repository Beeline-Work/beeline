import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { defaultSupervisorRoot, runtimeConfigPath } from './runtime.js';
import {
  ensureSquireHostDir,
  TRUSTY_SQUIRE_BROKER_UNIT_NAME,
  trustySquireBrokerUnit,
} from './squire-host.js';

const execFileAsync = promisify(execFile);

export const DELIBERATE_REMOVAL_EXIT_STATUS = 78;
/** A persistent daemon-start failure has been recorded; wait for an operator. */
export const DAEMON_DISTRESS_EXIT_STATUS = 77;
/** systemd addressed an agent whose durable runtime was already removed. */
export const UNKNOWN_AGENT_EXIT_STATUS = 79;
export const SYSTEMD_UNIT_NAME = 'beeline-agent@.service';
export const SYSTEMD_COMMAND_TIMEOUT_MS = 15_000;
/** Unit stop ceiling plus a small window for the successor to enter active. */
export const SYSTEMD_RESTART_WAIT_MS = 10 * 60_000 + 30_000;

/**
 * The portable supervision contract, rendered as a systemd user template.
 * PATH includes `%h/.local/bin` so every Cursor helper can resolve
 * `cursor-agent`; a host drop-in that replaces PATH must keep that entry.
 */
export function agentServiceUnit(): string {
  return `[Unit]
Description=Beeline agent %i
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=5min
StartLimitBurst=10

[Service]
Type=notify
NotifyAccess=all
Environment=BEELINE_MANAGED_BY_SYSTEMD=1
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/bin/beeline daemon --agent %i
Restart=always
RestartSec=5s
RestartSteps=5
RestartMaxDelaySec=60s
RestartPreventExitStatus=${DAEMON_DISTRESS_EXIT_STATUS} ${DELIBERATE_REMOVAL_EXIT_STATUS} ${UNKNOWN_AGENT_EXIT_STATUS}
SuccessExitStatus=${UNKNOWN_AGENT_EXIT_STATUS}
WatchdogSec=180s
TimeoutStartSec=90s
TimeoutStopSec=10min
KillMode=control-group
UMask=0077
# A desktop-launched user manager may inherit Ubuntu's unprivileged_userns
# AppArmor profile. Without an explicit transition every agent inherits it too,
# so /usr/bin/bwrap cannot enter its package-provided bwrap profile.
# Do not set NoNewPrivileges or PrivateTmp on this outer service: systemd applies
# either before AppArmorProfile, which blocks this transition. Bubblewrap sets
# no-new-privs and a private /tmp inside each agent sandbox it creates.
AppArmorProfile=-unconfined

[Install]
WantedBy=default.target
`;
}

/**
 * The user unit belongs to the installed launcher, never to a source checkout.
 * `BEELINE_LIB_DIR` is injected only by that launcher. Refusing here protects
 * the shared user-manager definition even when a test/lab calls `beeline start`.
 */
export function isCanonicalInstalledLauncher(
  env: NodeJS.ProcessEnv = process.env,
  invocationPath = process.argv[1],
): boolean {
  const home = env.HOME?.trim() || homedir();
  const expectedLibDir = resolve(home, '.local', 'lib', 'beeline');
  const expectedPrefix = `${expectedLibDir}/`;
  return (
    resolve(env.BEELINE_LIB_DIR?.trim() || '/') === expectedLibDir &&
    Boolean(invocationPath) &&
    resolve(invocationPath!).startsWith(expectedPrefix)
  );
}

function assertCanonicalInstalledLauncher(env: NodeJS.ProcessEnv, invocationPath?: string): void {
  if (isCanonicalInstalledLauncher(env, invocationPath)) return;
  throw new Error(
    'refusing to modify the shared Beeline systemd unit outside the canonical ~/.local/bin/beeline launcher',
  );
}

export function systemdUserUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), '.config');
  return resolve(configRoot, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

export function systemdBrokerUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), '.config');
  return resolve(configRoot, 'systemd', 'user', TRUSTY_SQUIRE_BROKER_UNIT_NAME);
}

/**
 * One host elector outside every agent sandbox: no PrivateTmp, shared socket.
 * Idempotent; enable --now keeps the daemon up for every façade.
 */
export async function installTrustySquireBrokerService(options: {
  env?: NodeJS.ProcessEnv;
  run?: SystemdRunner;
  invocationPath?: string;
} = {}): Promise<void> {
  const env = options.env ?? process.env;
  assertCanonicalInstalledLauncher(env, options.invocationPath);
  const home = env.HOME?.trim() || homedir();
  ensureSquireHostDir(home);
  const path = systemdBrokerUnitPath(env);
  const content = trustySquireBrokerUnit();
  const existing = await readFile(path, 'utf8').catch(() => '');
  if (existing !== content) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  }
  const run = options.run ?? runSystemctl;
  await run(['daemon-reload']);
  await run(['enable', '--now', TRUSTY_SQUIRE_BROKER_UNIT_NAME]);
}

export interface SystemdRunner {
  (args: string[]): Promise<{ stdout: string }>;
}

const AGENT_SERVICE = /^beeline-agent@([0-9a-f]{64})\.service$/i;

const runSystemctl: SystemdRunner = async (args) => {
  const result = await execFileAsync('systemctl', ['--user', ...args], {
    timeout: SYSTEMD_COMMAND_TIMEOUT_MS,
    encoding: 'utf8',
  });
  return { stdout: result.stdout };
};

export async function installAgentService(
  publicKey: string,
  options: {
    env?: NodeJS.ProcessEnv;
    run?: SystemdRunner;
    start?: boolean;
    waitTimeoutMs?: number;
    /** Test seam; production checks the running bundled CLI path. */
    invocationPath?: string;
  } = {},
): Promise<number> {
  if (!/^[0-9a-f]{64}$/i.test(publicKey)) throw new Error('agent public key must be 64 hex');
  const env = options.env ?? process.env;
  assertCanonicalInstalledLauncher(env, options.invocationPath);
  const path = systemdUserUnitPath(env);
  const content = agentServiceUnit();
  const existing = await readFile(path, 'utf8').catch(() => '');
  if (existing !== content) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  }
  const run = options.run ?? runSystemctl;
  await run(['daemon-reload']);
  const service = `beeline-agent@${publicKey}.service`;
  await run(['enable', service]);
  if (options.start === false) return 0;

  const before = await serviceStatus(run, service);
  // Used when start found no live daemon for this agent. A running unit is
  // started by the same operation. `--no-block` leaves the unit's ten-minute
  // graceful drain under systemd rather than the generic 15-second subprocess
  // timeout used for individual control calls.
  await run(['restart', '--no-block', service]);
  const deadline = Date.now() + (options.waitTimeoutMs ?? SYSTEMD_RESTART_WAIT_MS);
  do {
    const status = await serviceStatus(run, service);
    if (status.activeState === 'failed') {
      throw new Error(`systemd failed to start ${service} (${status.result || 'unknown result'})`);
    }
    if (status.pid > 0 && (before.pid === 0 || status.pid !== before.pid)) return status.pid;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`systemd did not replace ${service}'s MainPID before the restart deadline`);
}

async function serviceStatus(
  run: SystemdRunner,
  service: string,
): Promise<{ pid: number; activeState: string; result: string }> {
  const status = await run([
    'show',
    '--property=MainPID',
    '--property=ActiveState',
    '--property=Result',
    service,
  ]);
  const fields = new Map(
    status.stdout
      .split('\n')
      .map((line) => line.split('=', 2) as [string, string])
      .filter(([key]) => key.length > 0),
  );
  const pid = Number(fields.get('MainPID') ?? '0');
  return {
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : 0,
    activeState: fields.get('ActiveState') ?? '',
    result: fields.get('Result') ?? '',
  };
}

export async function disableAgentService(
  publicKey: string,
  options: { run?: SystemdRunner; stop?: boolean } = {},
): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(publicKey)) throw new Error('agent public key must be 64 hex');
  const run = options.run ?? runSystemctl;
  const service = `beeline-agent@${publicKey}.service`;
  // Disable first so Restart=always cannot win a race with the stop request.
  await run(['disable', service]);
  await run(['reset-failed', service]);
  // A legitimate drain may last minutes; do not kill systemctl at the generic
  // 15-second command deadline. The service cgroup and TimeoutStopSec own the
  // asynchronous stop job from here.
  if (options.stop !== false) await run(['stop', '--no-block', service]);
}

/** Enumerate only enabled, exact agent instances; malformed unit names are ignored. */
export async function enabledAgentServices(
  options: { run?: SystemdRunner } = {},
): Promise<Map<string, string>> {
  const run = options.run ?? runSystemctl;
  const result = await run([
    'list-unit-files',
    'beeline-agent@*.service',
    '--state=enabled',
    '--no-legend',
    '--no-pager',
  ]);
  const enabled = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const [unit, state] = line.trim().split(/\s+/, 3);
    const match = unit ? AGENT_SERVICE.exec(unit) : null;
    if (!match || state !== 'enabled') continue;
    enabled.set(match[1]!.toLowerCase(), unit!);
  }
  return enabled;
}

/** Probe the exact target instance, whether it is currently enabled or disabled. */
export async function agentServiceExists(
  publicKey: string,
  options: { run?: SystemdRunner } = {},
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(publicKey)) throw new Error('agent public key must be 64 hex');
  const run = options.run ?? runSystemctl;
  const service = `beeline-agent@${publicKey}.service`;
  const result = await run(['show', '--property=LoadState', '--value', service]);
  const loadState = result.stdout.trim();
  return loadState.length > 0 && loadState !== 'not-found';
}

/** Clean up one exact target instance when its unit exists. */
export async function cleanupAgentService(
  publicKey: string,
  options: { run?: SystemdRunner } = {},
): Promise<boolean> {
  if (!(await agentServiceExists(publicKey, options))) return false;
  await disableAgentService(publicKey, {
    stop: false,
    ...(options.run ? { run: options.run } : {}),
  });
  return true;
}

async function runtimeExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Heal enabled instances whose exact host runtime is absent. Existing runtime
 * paths are a hard safety boundary: their units are never mutated here.
 */
export async function reconcileAgentServices(
  options: {
    env?: NodeJS.ProcessEnv;
    run?: SystemdRunner;
    hasRuntime?: (configPath: string) => Promise<boolean>;
    reportFailure?: (unit: string, error: unknown) => void;
  } = {},
): Promise<string[]> {
  const env = options.env ?? process.env;
  const run = options.run ?? runSystemctl;
  const enabled = await enabledAgentServices({ run });
  const hasRuntime = options.hasRuntime ?? runtimeExists;
  const reportFailure =
    options.reportFailure ??
    ((unit: string, error: unknown) => {
      console.error(`[beeline] failed to reconcile orphan unit ${unit}:`, error);
    });
  const reconciled: string[] = [];
  for (const [publicKey, unit] of enabled) {
    try {
      const configPath = runtimeConfigPath(defaultSupervisorRoot(env), publicKey);
      if (await hasRuntime(configPath)) continue;
      await disableAgentService(publicKey, { run, stop: false });
      reconciled.push(publicKey);
    } catch (error) {
      reportFailure(unit, error);
    }
  }
  return reconciled;
}

export interface DaemonNotifier {
  ready(status: string): Promise<void>;
  progress(status: string): Promise<void>;
  stopping(status: string): Promise<void>;
}

async function notify(fields: string[]): Promise<void> {
  if (process.env.BEELINE_MANAGED_BY_SYSTEMD !== '1') return;
  await execFileAsync('systemd-notify', fields, { timeout: SYSTEMD_COMMAND_TIMEOUT_MS });
}

/**
 * Ask the service manager for more start time (`EXTEND_TIMEOUT_USEC`, honored
 * by `Type=notify` units while the unit is still starting). The successor's
 * comparison against the current release runs a second full probe inside the
 * 90s start deadline, which the first probe may already have spent.
 */
export async function extendSystemdStartTimeout(ms: number): Promise<void> {
  await notify([`EXTEND_TIMEOUT_USEC=${Math.max(0, Math.round(ms)) * 1000}`]).catch(() => undefined);
}

/** No timer lives here: callers may emit WATCHDOG only after a completed core tick. */
export class SystemdNotifier implements DaemonNotifier {
  async ready(status: string): Promise<void> {
    await notify(['--ready', `--status=${status}`]);
  }

  async progress(status: string): Promise<void> {
    await notify(['WATCHDOG=1', `STATUS=${status}`]);
  }

  async stopping(status: string): Promise<void> {
    await notify(['STOPPING=1', `STATUS=${status}`]);
  }
}
