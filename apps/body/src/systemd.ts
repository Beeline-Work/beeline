import { assertLifecycleTestIsolation } from './lifecycle-test-guard.js';
import { convergeNativeHelper } from './native-helper.js';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  updateSquireBrokerInstall,
  TRUSTY_SQUIRE_BROKER_UNIT_NAME,
  trustySquireBrokerUnit,
  writeSquireBrokerUnitMarker,
  type SquireInstallRunner,
} from './squire-host.js';

const execFileAsync = promisify(execFile);

/** One helper process per machine hosts every paired agent. */
export const SYSTEMD_HELPER_UNIT_NAME = 'beeline-helper.service';
export const SYSTEMD_COMMAND_TIMEOUT_MS = 15_000;

/**
 * The machine helper unit: one process hosts every agent paired on this host
 * and holds one heartbeat-checked socket for all of them. A crash of that one
 * process takes every agent down until systemd restarts it (RestartSec).
 *
 * `OOMPolicy=continue` keeps the helper alive when the kernel OOM-kills one
 * harness child; `OOMScoreAdjust=-1000` keeps the helper itself off the
 * victim list. `ExecReload` asks the helper to rescan paired agents, which is
 * how pairing, `beeline start` and `beeline stop` add or remove one agent
 * without touching the others. PATH includes `%h/.local/bin` so every Cursor
 * agent can resolve `cursor-agent`; a host drop-in that replaces PATH must keep
 * that entry.
 */
export { helperServiceUnit } from './native-helper.js';
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

export function systemdBrokerUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), '.config');
  return resolve(configRoot, 'systemd', 'user', TRUSTY_SQUIRE_BROKER_UNIT_NAME);
}

/**
 * One host elector outside every agent sandbox: no PrivateTmp, shared socket.
 * Idempotent; enable --now keeps the daemon up for every façade.
 */
export async function installTrustySquireBrokerService(
  options: {
    env?: NodeJS.ProcessEnv;
    run?: SystemdRunner;
    invocationPath?: string;
    /**
     * Restart the elector even when the unit content is unchanged. The managed
     * self-update path passes this after activating a new bundle: the unit's
     * ExecStart still names the launcher, but the running elector predates the
     * activation and must be re-executed onto the new bundle.
     */
    restart?: boolean;
    /** Injectable for tests; forwarded to `updateSquireBrokerInstall`. */
    squireInstallRun?: SquireInstallRunner;
    squireUpdateMode?: 'latest' | 'minimum';
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  assertLifecycleTestIsolation(env, Boolean(options.run));
  assertCanonicalInstalledLauncher(env, options.invocationPath);
  const home = env.HOME?.trim() || homedir();
  writeSquireBrokerUnitMarker(home);
  // Deliberate update point: pin the durable broker install before the unit
  // (re)starts, so a crash-restart never has to touch npm at all.
  const install = await updateSquireBrokerInstall(home, {
    ...(options.squireInstallRun ? { run: options.squireInstallRun } : {}),
    mode: options.squireUpdateMode ?? 'latest',
  });
  const path = systemdBrokerUnitPath(env);
  const content = trustySquireBrokerUnit();
  const existing = await readFile(path, 'utf8').catch(() => '');
  const changed = existing !== content;
  if (changed) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  }
  const run = options.run ?? runSystemctl;
  await run(['daemon-reload']);
  await run(['enable', TRUSTY_SQUIRE_BROKER_UNIT_NAME]);
  // A rewritten unit (or an explicit update) must be re-executed: the running
  // elector keeps the old PATH until systemd restarts it. An unchanged,
  // already-running elector is left alone.
  if (changed || install.changed || options.restart) {
    await run(['restart', '--no-block', TRUSTY_SQUIRE_BROKER_UNIT_NAME]);
  } else {
    await run(['start', TRUSTY_SQUIRE_BROKER_UNIT_NAME]);
  }
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

/**
 * Install the machine helper and make it host the current set of paired
 * agents. A running helper is asked to rescan (`reload`): agents already
 * serving are not restarted. A stopped helper is started. Every per-agent unit
 * left from before the machine helper is retired here, so no agent is ever
 * served by two processes once this returns.
 */
export async function installHelperService(
  options: {
    env?: NodeJS.ProcessEnv;
    run?: SystemdRunner;
    start?: boolean;
    waitTimeoutMs?: number;
    /** Test seam; production checks the running bundled CLI path. */
    invocationPath?: string;
    selfAgent?: string;
  } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  assertLifecycleTestIsolation(env, Boolean(options.run));
  assertCanonicalInstalledLauncher(env, options.invocationPath);
  if (options.start === false) throw new Error('installing a disabled helper is unsupported');
  return convergeNativeHelper({
    env,
    platform: 'systemd',
    ...(options.run ? { run: options.run } : {}),
    ...(options.selfAgent ? { legacyCaller: `beeline-agent@${options.selfAgent}.service` } : {}),
  });
}

/** Ask a running machine helper to rescan paired agents. A stopped one is left stopped. */
export async function reloadHelperService(options: { run?: SystemdRunner } = {}): Promise<boolean> {
  assertLifecycleTestIsolation(process.env, Boolean(options.run));
  const run = options.run ?? runSystemctl;
  const status = await serviceStatus(run, SYSTEMD_HELPER_UNIT_NAME);
  if (status.activeState !== 'active' || status.pid === 0) return false;
  await run(['reload', SYSTEMD_HELPER_UNIT_NAME]);
  return true;
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

/**
 * A retired agent's per-agent unit, if one is still installed from before the
 * machine helper, must not resurrect it with revoked tokens.
 */
export async function cleanupAgentService(
  publicKey: string,
  options: { run?: SystemdRunner } = {},
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(publicKey)) throw new Error('agent public key must be 64 hex');
  assertLifecycleTestIsolation(process.env, Boolean(options.run));
  const run = options.run ?? runSystemctl;
  const unit = `beeline-agent@${publicKey.toLowerCase()}.service`;
  const loadState = (await run(['show', '--property=LoadState', '--value', unit])).stdout.trim();
  if (!loadState || loadState === 'not-found') return false;
  await run(['disable', unit]);
  await run(['reset-failed', unit]);
  return true;
}

export interface DaemonNotifier {
  ready(status: string): Promise<void>;
  progress(status: string, watchdog?: boolean): Promise<void>;
  stopping(status: string): Promise<void>;
}

async function notify(fields: string[]): Promise<void> {
  if (process.env.BEELINE_MANAGED_BY_SYSTEMD !== '1') return;
  await execFileAsync('systemd-notify', fields, { timeout: SYSTEMD_COMMAND_TIMEOUT_MS });
}

/** Extend startup while interrupted-turn replay waits for a network reconnect. */
export async function extendSystemdStartTimeout(ms: number): Promise<void> {
  await notify([`EXTEND_TIMEOUT_USEC=${Math.max(0, Math.round(ms)) * 1000}`]).catch(
    () => undefined,
  );
}

/** systemd notification transport; only acknowledged work-loop ticks renew the watchdog. */
export class SystemdNotifier implements DaemonNotifier {
  async ready(status: string): Promise<void> {
    await notify(['--ready', `--status=${status}`]);
  }

  async progress(status: string, watchdog = false): Promise<void> {
    await notify([...(watchdog ? ['WATCHDOG=1'] : []), `STATUS=${status}`]);
  }

  async stopping(status: string): Promise<void> {
    await notify(['STOPPING=1', `STATUS=${status}`]);
  }
}

/**
 * Wake idle work loops locally and renew systemd only after all acknowledge.
 * No server read is needed. It runs only when systemd armed a watchdog. A failed notification
 * is logged: it must never become an unhandled rejection that kills the helper.
 */
export function startLocalWatchdog(
  notifier: Pick<DaemonNotifier, 'progress'>,
  status: () => string,
  workLoopProgress: () => Promise<void | boolean>,
  intervalMs: number | undefined = undefined,
  env: NodeJS.ProcessEnv = process.env,
  onStall: () => void = () => process.exit(75),
): () => void {
  const localDeadline = process.platform === 'darwin';
  if (!env.WATCHDOG_USEC && !localDeadline) return () => undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let stopped = false;
  const timer = setInterval(
    () => {
      if (pending || stopped) return;
      pending = true;
      if (localDeadline && !deadline) deadline = setTimeout(onStall, 180_000);
      // The existing local tick asks the work loops to run. A wedged loop never
      // completes this barrier, even while sockets and other agents keep running.
      void workLoopProgress()
        .then((progressed) => {
          if (progressed !== false) {
            clearTimeout(deadline);
            deadline = undefined;
          }
          return stopped || progressed === false || localDeadline
            ? undefined
            : notifier.progress(status(), true);
        })
        .catch((error) => console.error('[thin-core] watchdog notification failed:', error))
        .finally(() => {
          pending = false;
        });
    },
    intervalMs ?? Math.min(60_000, Math.max(100, Number(env.WATCHDOG_USEC || 180_000_000) / 3000)),
  );
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(deadline);
  };
}
