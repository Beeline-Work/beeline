import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DELIBERATE_REMOVAL_EXIT_STATUS = 78;
export const SYSTEMD_UNIT_NAME = 'beeline-agent@.service';
export const EVENTS_SYSTEMD_UNIT_NAME = 'beeline-events.service';
export const SYSTEMD_COMMAND_TIMEOUT_MS = 15_000;
export const MINIMUM_SYSTEMD_NODE_VERSION = '20.11.0';
/** Unit stop ceiling plus a small window for the successor to enter active. */
export const SYSTEMD_RESTART_WAIT_MS = 10 * 60_000 + 30_000;

function systemdQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** The portable supervision contract, rendered as a systemd user template. */
export function agentServiceUnit(
  entrypoint = resolve(homedir(), '.local', 'bin', 'beeline'),
  nodePath = process.execPath,
  inheritedPath = process.env.PATH ?? '',
): string {
  if (!isAbsolute(nodePath)) throw new Error('systemd Node path must be absolute');
  const nodeDir = dirname(nodePath);
  const path = [
    nodeDir,
    ...inheritedPath.split(delimiter).filter((part) => part && part !== nodeDir),
  ].join(delimiter);
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
Environment=${systemdQuote(`PATH=${path}`)}
ExecStart=${systemdQuote(entrypoint)} daemon --agent %i
Restart=always
RestartSec=5s
RestartSteps=5
RestartMaxDelaySec=60s
RestartPreventExitStatus=${DELIBERATE_REMOVAL_EXIT_STATUS}
WatchdogSec=180s
TimeoutStartSec=90s
TimeoutStopSec=10min
KillMode=control-group
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
`;
}

/** Single-instance repository event ingestion under the thin-core lifecycle contract. */
export function eventsServiceUnit(
  entrypoint = resolve(homedir(), '.local', 'bin', 'beeline'),
  nodePath = process.execPath,
  inheritedPath = process.env.PATH ?? '',
): string {
  if (!isAbsolute(nodePath)) throw new Error('systemd Node path must be absolute');
  const nodeDir = dirname(nodePath);
  const path = [
    nodeDir,
    ...inheritedPath.split(delimiter).filter((part) => part && part !== nodeDir),
  ].join(delimiter);
  return `[Unit]
Description=Beeline repository event ingestion
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=5min
StartLimitBurst=10

[Service]
Type=notify
NotifyAccess=all
Environment=BEELINE_MANAGED_BY_SYSTEMD=1
Environment=${systemdQuote(`PATH=${path}`)}
EnvironmentFile=-%h/.config/beeline/events.env
ExecStart=${systemdQuote(entrypoint)} events daemon
Restart=always
RestartSec=5s
RestartSteps=5
RestartMaxDelaySec=60s
WatchdogSec=180s
TimeoutStartSec=90s
TimeoutStopSec=90s
KillMode=control-group
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
`;
}

function assertSupportedNodeVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  const [major, minor, patch] = match?.slice(1, 4).map(Number) ?? [];
  const supported =
    major !== undefined &&
    minor !== undefined &&
    patch !== undefined &&
    (major > 20 || (major === 20 && minor >= 11));
  if (!supported) {
    throw new Error(
      `Cannot install the Beeline systemd service with Node.js ${version}; ` +
        `Node.js ${MINIMUM_SYSTEMD_NODE_VERSION} or newer is required. ` +
        'Run beeline again using a supported Node installation (for example, activate your fnm/nvm version first).',
    );
  }
}

export function systemdUserUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), '.config');
  return resolve(configRoot, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

export function eventsSystemdUserUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), '.config');
  return resolve(configRoot, 'systemd', 'user', EVENTS_SYSTEMD_UNIT_NAME);
}

export interface SystemdRunner {
  (args: string[]): Promise<{ stdout: string }>;
}

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
    entrypoint?: string;
    env?: NodeJS.ProcessEnv;
    run?: SystemdRunner;
    start?: boolean;
    waitTimeoutMs?: number;
    nodePath?: string;
    nodeVersion?: string;
  } = {},
): Promise<number> {
  if (!/^[0-9a-f]{64}$/i.test(publicKey)) throw new Error('agent public key must be 64 hex');
  const nodePath = options.nodePath ?? process.execPath;
  assertSupportedNodeVersion(options.nodeVersion ?? process.versions.node);
  const path = systemdUserUnitPath(options.env);
  const content = agentServiceUnit(
    options.entrypoint,
    nodePath,
    options.env?.PATH ?? process.env.PATH,
  );
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
  // restart is intentional: `beeline start` has always meant restart, while
  // an inactive/new unit is started by the same operation. `--no-block`
  // leaves the unit's ten-minute graceful drain under systemd rather than the
  // generic 15-second subprocess timeout used for individual control calls.
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
  // A legitimate drain may last minutes; do not kill systemctl at the generic
  // 15-second command deadline. The service cgroup and TimeoutStopSec own the
  // asynchronous stop job from here.
  if (options.stop !== false) await run(['stop', '--no-block', service]);
}

export async function installEventsService(
  options: {
    entrypoint?: string;
    env?: NodeJS.ProcessEnv;
    run?: SystemdRunner;
    start?: boolean;
    nodePath?: string;
    nodeVersion?: string;
  } = {},
): Promise<void> {
  const nodePath = options.nodePath ?? process.execPath;
  assertSupportedNodeVersion(options.nodeVersion ?? process.versions.node);
  const path = eventsSystemdUserUnitPath(options.env);
  const content = eventsServiceUnit(
    options.entrypoint,
    nodePath,
    options.env?.PATH ?? process.env.PATH,
  );
  const existing = await readFile(path, 'utf8').catch(() => '');
  if (existing !== content) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  }
  const run = options.run ?? runSystemctl;
  await run(['daemon-reload']);
  await run(['enable', EVENTS_SYSTEMD_UNIT_NAME]);
  if (options.start !== false) await run(['restart', '--no-block', EVENTS_SYSTEMD_UNIT_NAME]);
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
