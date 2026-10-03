import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  ensureSquireBrokerInstall,
  TRUSTY_SQUIRE_BROKER_UNIT_NAME,
  trustySquireBrokerUnit,
  writeSquireBrokerUnitMarker,
  type SquireInstallRunner,
} from './squire-host.js';

const execFileAsync = promisify(execFile);

export const DELIBERATE_REMOVAL_EXIT_STATUS = 78;
/** A persistent daemon-start failure has been recorded; wait for an operator. */
export const DAEMON_DISTRESS_EXIT_STATUS = 77;
/** systemd addressed an agent whose durable runtime was already removed. */
export const UNKNOWN_AGENT_EXIT_STATUS = 79;
/** The pre-machine per-agent template; only migration and rollback still name it. */
export const SYSTEMD_UNIT_NAME = 'beeline-agent@.service';
/** One helper process per machine hosts every paired agent. */
export const SYSTEMD_HELPER_UNIT_NAME = 'beeline-helper.service';
/** The helper machine found no agent to host; nothing restarts it until one is paired. */
export const NO_AGENTS_EXIT_STATUS = UNKNOWN_AGENT_EXIT_STATUS;
export const SYSTEMD_COMMAND_TIMEOUT_MS = 15_000;
/** Unit stop ceiling plus a small window for the successor to enter active. */
export const SYSTEMD_RESTART_WAIT_MS = 90_000 + 30_000;

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
export function helperServiceUnit(): string {
  return `[Unit]
Description=Beeline helper (every agent on this machine)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=notify
NotifyAccess=all
Environment=BEELINE_MANAGED_BY_SYSTEMD=1
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/bin/beeline daemon --machine
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=5s
RestartSteps=5
RestartMaxDelaySec=60s
RestartPreventExitStatus=${NO_AGENTS_EXIT_STATUS}
SuccessExitStatus=${NO_AGENTS_EXIT_STATUS}
WatchdogSec=180s
CPUWeight=1000
IOWeight=1000
Nice=-5
OOMScoreAdjust=-1000
OOMPolicy=continue
TimeoutStartSec=90s
TimeoutStopSec=90s
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
 * The pre-machine per-agent template. Written only when a rollback restores a
 * release that predates the machine helper, so that release can serve again.
 * PATH includes `%h/.local/bin` so every Cursor helper can resolve
 * `cursor-agent`; a host drop-in that replaces PATH must keep that entry.
 *
 * `OOMPolicy=continue` is load-bearing: systemd's default `stop` tears the whole
 * unit down when the kernel OOM-kills any process in its cgroup, which on this
 * host means one memory-hungry harness would take every other agent's daemon
 * with it. `OOMScoreAdjust=-1000` keeps the daemon itself off the kernel's
 * victim list so the child is the one reclaimed.
 */
export function agentServiceUnit(): string {
  return `[Unit]
Description=Beeline agent %i
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

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
CPUWeight=1000
IOWeight=1000
Nice=-5
OOMScoreAdjust=-1000
OOMPolicy=continue
TimeoutStartSec=90s
TimeoutStopSec=90s
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

function assertCanonicalInstalledLauncher(
  env: NodeJS.ProcessEnv,
  invocationPath?: string,
): void {
  if (isCanonicalInstalledLauncher(env, invocationPath)) return;
  throw new Error(
    'refusing to modify the shared Beeline systemd unit outside the canonical ~/.local/bin/beeline launcher',
  );
}

export function systemdUserUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), '.config');
  return resolve(configRoot, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

export function systemdHelperUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), '.config');
  return resolve(configRoot, 'systemd', 'user', SYSTEMD_HELPER_UNIT_NAME);
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
    /** Injectable for tests; forwarded to `ensureSquireBrokerInstall`. */
    squireInstallRun?: SquireInstallRunner;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  assertCanonicalInstalledLauncher(env, options.invocationPath);
  const home = env.HOME?.trim() || homedir();
  writeSquireBrokerUnitMarker(home);
  // Deliberate update point: pin the durable broker install before the unit
  // (re)starts, so a crash-restart never has to touch npm at all.
  await ensureSquireBrokerInstall(
    home,
    options.squireInstallRun ? { run: options.squireInstallRun } : {},
  );
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
  if (changed || options.restart) {
    await run(['restart', '--no-block', TRUSTY_SQUIRE_BROKER_UNIT_NAME]);
  } else {
    await run(['start', TRUSTY_SQUIRE_BROKER_UNIT_NAME]);
  }
}

/**
 * Install + restart the host elector from the managed self-update path.
 *
 * Activation swaps the bundle anchor from a process that is NOT the canonical
 * `<prefix>/bin/beeline` launcher — `npx usebeeline update` runs from an npm
 * cache, and the managed worker runs from the bundle it is replacing. Rather
 * than refuse, the caller supplies the anchor it just activated, which is
 * exactly what the launcher exports as BEELINE_LIB_DIR, so the canonicality
 * refusal that protects a source checkout is unchanged. Best-effort: the
 * update already succeeded, so a host without systemd user services logs and
 * keeps its stale unit instead of failing the release.
 */
export async function convergeTrustySquireBrokerService(options: {
  libDir: string;
  env?: NodeJS.ProcessEnv;
  run?: SystemdRunner;
  log?: (line: string) => void;
}): Promise<boolean> {
  const env = options.env ?? process.env;
  try {
    await installTrustySquireBrokerService({
      env: { ...env, BEELINE_LIB_DIR: options.libDir },
      invocationPath: resolve(options.libDir, 'lib', 'beeline', 'beeline-cli.mjs'),
      restart: true,
      ...(options.run ? { run: options.run } : {}),
    });
    return true;
  } catch (error) {
    options.log?.(
      `[beeline] host Squire broker unit not converged: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Rewrite the installed helper unit from the running bundle without
 * restarting it. `beeline start`/pairing rewrites the unit on install, but a
 * managed update would otherwise keep the old unit forever. The new content
 * takes effect on the helper's next start, which the update handoff performs.
 * A host still on per-agent units is left alone: its first daemon start on the
 * new bundle migrates it. Best-effort: the release is already live.
 */
export async function convergeHelperServiceUnit(options: {
  libDir: string;
  env?: NodeJS.ProcessEnv;
  run?: SystemdRunner;
  log?: (line: string) => void;
}): Promise<boolean> {
  const env = options.env ?? process.env;
  try {
    assertCanonicalInstalledLauncher(
      env,
      resolve(options.libDir, 'lib', 'beeline', 'beeline-cli.mjs'),
    );
    const path = systemdHelperUnitPath(env);
    const existing = await readFile(path, 'utf8').catch(() => '');
    const content = helperServiceUnit();
    if (!existing || existing === content) return false;
    await writeFile(path, content, { mode: 0o600 });
    const run = options.run ?? runSystemctl;
    await run(['daemon-reload']);
    options.log?.('[beeline] helper systemd unit updated; it applies on the next helper restart');
    return true;
  } catch (error) {
    options.log?.(
      `[beeline] helper systemd unit not converged: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
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
  } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  assertCanonicalInstalledLauncher(env, options.invocationPath);
  const path = systemdHelperUnitPath(env);
  const content = helperServiceUnit();
  const existing = await readFile(path, 'utf8').catch(() => '');
  if (existing !== content) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  }
  const run = options.run ?? runSystemctl;
  await run(['daemon-reload']);
  await run(['enable', SYSTEMD_HELPER_UNIT_NAME]);
  if (options.start === false) {
    await retireLegacyAgentUnits({ env, run });
    return 0;
  }
  // The helper starts before any per-agent unit is retired: this may run
  // inside one of those units, and retiring it stops this very process. The
  // helper waits for each agent's old process to exit before serving it.
  const before = await serviceStatus(run, SYSTEMD_HELPER_UNIT_NAME);
  if (before.activeState === 'active' && before.pid > 0) {
    await run(['reload', SYSTEMD_HELPER_UNIT_NAME]);
    await retireLegacyAgentUnits({ env, run });
    return before.pid;
  }
  // `--no-block` leaves the start job (and a previous stop's drain) to systemd
  // rather than the generic 15-second subprocess timeout.
  await run(['reset-failed', SYSTEMD_HELPER_UNIT_NAME]).catch(() => undefined);
  await run(['restart', '--no-block', SYSTEMD_HELPER_UNIT_NAME]);
  const deadline = Date.now() + (options.waitTimeoutMs ?? SYSTEMD_RESTART_WAIT_MS);
  do {
    const status = await serviceStatus(run, SYSTEMD_HELPER_UNIT_NAME);
    if (status.activeState === 'failed') {
      throw new Error(
        `systemd failed to start ${SYSTEMD_HELPER_UNIT_NAME} (${status.result || 'unknown result'})`,
      );
    }
    // Type=notify: ActiveState reaches 'active' only once the helper itself
    // calls sd_notify READY — i.e. it imported successfully, hosted every
    // agent, and established them (machine-helper.ts). A changed MainPID
    // alone is true the instant systemd spawns ANY attempt, including one
    // that is about to crash on import and restart-loop forever without ever
    // reaching 'failed' (Restart=always, no start limit) — exactly the
    // incident that stopped every legacy per-agent unit the moment a
    // crash-looping helper process first appeared, with nothing left able
    // to serve.
    if (status.activeState === 'active' && status.pid > 0) {
      await retireLegacyAgentUnits({ env, run });
      return status.pid;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  // Never confirmed healthy: stop it so a crash-looping unit does not keep
  // restarting in the background once this call returns control to a caller
  // that assumes the attempt is over, and so the legacy per-agent units —
  // never retired above — remain the only thing serving until a fixed
  // release lands (the caller's own failure path rolls that back; see
  // cli.ts's migrateLegacyAgentUnit / successorRollbackAllowed).
  await run(['disable', SYSTEMD_HELPER_UNIT_NAME]).catch(() => undefined);
  await run(['stop', '--no-block', SYSTEMD_HELPER_UNIT_NAME]).catch(() => undefined);
  throw new Error(
    `${SYSTEMD_HELPER_UNIT_NAME} did not become healthy before the restart deadline; legacy per-agent units were left serving`,
  );
}

/** Ask a running machine helper to rescan paired agents. A stopped one is left stopped. */
export async function reloadHelperService(options: { run?: SystemdRunner } = {}): Promise<boolean> {
  const run = options.run ?? runSystemctl;
  const status = await serviceStatus(run, SYSTEMD_HELPER_UNIT_NAME);
  if (status.activeState !== 'active' || status.pid === 0) return false;
  await run(['reload', SYSTEMD_HELPER_UNIT_NAME]);
  return true;
}

/**
 * Retire every per-agent unit from before the machine helper: disabled first
 * so `Restart=always` cannot race the stop, then stopped without blocking (a
 * draining agent finishes under systemd). The template file goes too. Each
 * runtime directory is untouched; the machine helper serves it next.
 */
export async function retireLegacyAgentUnits(
  options: { env?: NodeJS.ProcessEnv; run?: SystemdRunner } = {},
): Promise<string[]> {
  const env = options.env ?? process.env;
  const run = options.run ?? runSystemctl;
  const units = await legacyAgentUnits({ run });
  for (const unit of units) {
    await run(['disable', unit]).catch(() => undefined);
    await run(['reset-failed', unit]).catch(() => undefined);
    await run(['stop', '--no-block', unit]).catch(() => undefined);
  }
  const template = systemdUserUnitPath(env);
  if (await readFile(template, 'utf8').then(() => true, () => false)) {
    await rm(template, { force: true });
    await run(['daemon-reload']);
  }
  return units;
}

/** Every loaded or enabled `beeline-agent@<key>.service`, whatever its state. */
async function legacyAgentUnits(options: { run: SystemdRunner }): Promise<string[]> {
  const units = new Set<string>();
  for (const args of [
    ['list-unit-files', 'beeline-agent@*.service', '--no-legend', '--no-pager'],
    ['list-units', '--all', 'beeline-agent@*.service', '--no-legend', '--no-pager', '--plain'],
  ]) {
    const result = await options.run(args).catch(() => ({ stdout: '' }));
    for (const line of result.stdout.split('\n')) {
      const unit = line.trim().split(/\s+/, 1)[0];
      if (unit && AGENT_SERVICE.test(unit)) units.add(unit);
    }
  }
  return [...units].sort();
}

/**
 * A rollback restored a release that may predate the machine helper, and that
 * release cannot run `daemon --machine`. Give each paired agent its per-agent
 * unit back and stand the helper unit down; a restored release that does know
 * the machine helper migrates straight back on its first start.
 */
export async function restoreLegacyAgentUnits(
  publicKeys: readonly string[],
  options: { env?: NodeJS.ProcessEnv; run?: SystemdRunner } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const run = options.run ?? runSystemctl;
  const template = systemdUserUnitPath(env);
  await mkdir(dirname(template), { recursive: true, mode: 0o700 });
  await writeFile(template, agentServiceUnit(), { mode: 0o600 });
  await run(['daemon-reload']);
  for (const publicKey of publicKeys) {
    if (!/^[0-9a-f]{64}$/i.test(publicKey)) continue;
    const unit = `beeline-agent@${publicKey.toLowerCase()}.service`;
    await run(['enable', unit]);
    await run(['start', '--no-block', unit]);
  }
  await run(['disable', SYSTEMD_HELPER_UNIT_NAME]);
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

/** systemd notification transport; the local watchdog timer below never reads the server. */
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

/**
 * Keep an idle, socket-connected helper alive in systemd without a server
 * read. It runs only when systemd armed a watchdog, and a failed notification
 * is logged: it must never become an unhandled rejection that kills the helper.
 */
export function startLocalWatchdog(
  notifier: Pick<DaemonNotifier, 'progress'>,
  status: () => string,
  intervalMs = 60_000,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  if (!env.WATCHDOG_USEC) return () => undefined;
  const timer = setInterval(
    () =>
      void notifier
        .progress(status())
        .catch((error) => console.error('[thin-core] watchdog notification failed:', error)),
    intervalMs,
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
