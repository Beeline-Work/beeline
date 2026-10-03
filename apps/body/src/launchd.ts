import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SQUIRE_BROKER_FLAG, squireHostRewriteEnv, writeSquireBrokerUnitMarker } from './squire-host.js';
import {
  DAEMON_DISTRESS_EXIT_STATUS,
  DELIBERATE_REMOVAL_EXIT_STATUS,
  isCanonicalInstalledLauncher,
  NO_AGENTS_EXIT_STATUS,
  UNKNOWN_AGENT_EXIT_STATUS,
} from './systemd.js';

const execFileAsync = promisify(execFile);

/** Pre-machine per-agent jobs; only migration and rollback still name them. */
export const LAUNCHD_AGENT_LABEL_PREFIX = 'app.usebeeline.agent.';
/** One helper job per machine hosts every paired agent. */
export const LAUNCHD_HELPER_LABEL = 'app.usebeeline.helper';
export const LAUNCHD_BROKER_LABEL = 'app.usebeeline.trusty-squire-broker';
export const LAUNCHD_COMMAND_TIMEOUT_MS = 15_000;
export const LAUNCHD_RESTART_WAIT_MS = 10 * 60_000 + 30_000;
/** How long a bootstrap keeps retrying the refusal a just-removed label causes. */
export const LAUNCHD_BOOTSTRAP_WAIT_MS = 10_000;
const LAUNCHD_BOOTSTRAP_RETRY_INTERVAL_MS = 100;
/** Mirrors systemd's `TimeoutStopSec=10min`: a legitimate drain lasts minutes. */
export const LAUNCHD_EXIT_TIMEOUT_SECONDS = 600;
export const LAUNCHD_STOP_TIMEOUT_MS = LAUNCHD_EXIT_TIMEOUT_SECONDS * 1_000 + 30_000;

export interface LaunchdRunner {
  (args: string[], options?: { timeoutMs?: number }): Promise<{ stdout: string }>;
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function launchdHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

function nodeBinDirectory(): string {
  try {
    // fnm and similar managers expose node through a per-shell symlink. Store
    // the real version directory so the LaunchAgent still starts after login.
    return dirname(realpathSync(process.execPath));
  } catch {
    return dirname(process.execPath);
  }
}

export function launchdUserDomain(uid = process.getuid?.()): string {
  if (!Number.isSafeInteger(uid) || (uid ?? -1) < 0) {
    throw new Error('launchd user supervision requires a numeric uid');
  }
  return `gui/${uid}`;
}

export function launchdAgentLabel(publicKey: string): string {
  if (!/^[0-9a-f]{64}$/i.test(publicKey)) throw new Error('agent public key must be 64 hex');
  return `${LAUNCHD_AGENT_LABEL_PREFIX}${publicKey.toLowerCase()}`;
}

export function launchdAgentPlistPath(
  publicKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(
    launchdHome(env),
    'Library',
    'LaunchAgents',
    `${launchdAgentLabel(publicKey)}.plist`,
  );
}

export function launchdHelperPlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(launchdHome(env), 'Library', 'LaunchAgents', `${LAUNCHD_HELPER_LABEL}.plist`);
}

export function launchdHelperSupervisorPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    launchdHome(env),
    'Library',
    'Application Support',
    'Beeline',
    'bin',
    'supervise-helper',
  );
}

/**
 * The machine helper's wrapper: the same SIGTERM forwarding and status
 * mapping as the per-agent one. A helper that found no agent to host exits
 * with the no-agents status, which maps to 0 so KeepAlive leaves it stopped
 * until pairing starts it again; every other exit is restarted.
 */
export function launchdHelperSupervisorScript(): string {
  return `#!/bin/sh
set -u
"$1" daemon --machine &
child=$!
trap 'kill -TERM "$child" 2>/dev/null' TERM INT
trap 'kill -HUP "$child" 2>/dev/null' HUP
wait "$child"
status=$?
while [ "$status" -gt 128 ] && kill -0 "$child" 2>/dev/null; do
  wait "$child"
  status=$?
done
case "$status" in
  ${NO_AGENTS_EXIT_STATUS}) exit 0 ;;
  *) exit 1 ;;
esac
`;
}

export function launchdHelperPlist(env: NodeJS.ProcessEnv = process.env): string {
  const home = launchdHome(env);
  const logDir = resolve(home, 'Library', 'Logs', 'Beeline');
  const path = launchdJobPath(home);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_HELPER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(launchdHelperSupervisorPath(env))}</string>
    <string>${xml(resolve(home, '.local', 'bin', 'beeline'))}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml({ HOME: home, PATH: path })}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>${LAUNCHD_EXIT_TIMEOUT_SECONDS}</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(resolve(logDir, 'helper.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(resolve(logDir, 'helper.log'))}</string>
</dict>
</plist>
`;
}

export function launchdBrokerPlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(launchdHome(env), 'Library', 'LaunchAgents', `${LAUNCHD_BROKER_LABEL}.plist`);
}

export function launchdAgentSupervisorPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    launchdHome(env),
    'Library',
    'Application Support',
    'Beeline',
    'bin',
    'supervise-agent',
  );
}

/**
 * launchd cannot express systemd's RestartPreventExitStatus list. The small
 * installed wrapper preserves the same contract instead: launchd restarts a
 * failed job, so ordinary clean/hiccup exits become 1 while the three
 * deliberate terminal statuses become 0 and remain stopped.
 *
 * The daemon runs as a backgrounded child with SIGTERM forwarded to it: a
 * non-interactive shell dies on SIGTERM without signalling or waiting for a
 * FOREGROUND child, which would skip the daemon's own drain and make the
 * plist's ExitTimeOut ceiling unreachable. `wait` interrupted by the trapped
 * signal returns >128 while the child is still draining, so it is resumed
 * until the child's real status is in hand.
 */
export function launchdAgentSupervisorScript(): string {
  return `#!/bin/sh
set -u
"$2" daemon --agent "$1" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null' TERM INT
wait "$child"
status=$?
while [ "$status" -gt 128 ] && kill -0 "$child" 2>/dev/null; do
  wait "$child"
  status=$?
done
case "$status" in
  ${DAEMON_DISTRESS_EXIT_STATUS}|${DELIBERATE_REMOVAL_EXIT_STATUS}|${UNKNOWN_AGENT_EXIT_STATUS}) exit 0 ;;
  *) exit 1 ;;
esac
`;
}

/**
 * What a Beeline launchd job may resolve binaries from. `nodeBinDirectory()`
 * comes first so an fnm/nvm-installed node and the harness bins beside it are
 * reachable from a LaunchAgent, whose PATH is otherwise the bare default.
 */
function launchdJobPath(home: string): string {
  return [
    nodeBinDirectory(),
    resolve(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
  ].join(':');
}

function environmentXml(environment: Readonly<Record<string, string>>): string {
  return Object.entries(environment)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join('\n');
}

export function launchdAgentPlist(publicKey: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = launchdHome(env);
  const label = launchdAgentLabel(publicKey);
  const logDir = resolve(home, 'Library', 'Logs', 'Beeline');
  const path = launchdJobPath(home);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(launchdAgentSupervisorPath(env))}</string>
    <string>${xml(publicKey.toLowerCase())}</string>
    <string>${xml(resolve(home, '.local', 'bin', 'beeline'))}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml({ HOME: home, PATH: path })}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>${LAUNCHD_EXIT_TIMEOUT_SECONDS}</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(resolve(logDir, `agent-${publicKey.toLowerCase()}.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(resolve(logDir, `agent-${publicKey.toLowerCase()}.log`))}</string>
</dict>
</plist>
`;
}

export function launchdBrokerPlist(env: NodeJS.ProcessEnv = process.env): string {
  const home = launchdHome(env);
  const host = squireHostRewriteEnv(home);
  const log = resolve(home, 'Library', 'Logs', 'Beeline', 'trusty-squire-broker.log');
  const path = launchdJobPath(home);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_BROKER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(resolve(home, '.local', 'bin', 'beeline'))}</string>
    <string>${SQUIRE_BROKER_FLAG}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml({ HOME: home, PATH: path, ...host })}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function assertCanonicalInstalledLauncher(env: NodeJS.ProcessEnv, invocationPath?: string): void {
  if (isCanonicalInstalledLauncher(env, invocationPath)) return;
  throw new Error(
    'refusing to modify shared Beeline launchd jobs outside the canonical ~/.local/bin/beeline launcher',
  );
}

const runLaunchctl: LaunchdRunner = async (args, options) => {
  const result = await execFileAsync('launchctl', args, {
    timeout: options?.timeoutMs ?? LAUNCHD_COMMAND_TIMEOUT_MS,
    encoding: 'utf8',
  });
  return { stdout: result.stdout };
};

/**
 * One supervisor script serves every agent on the host, and `sh` reads its
 * script lazily from the open file's offset: rewriting it in place while another
 * agent's shell sits in `wait` resumes that shell on new bytes at an old offset.
 * The replacement is a rename onto the path, the same primitive install.sh uses
 * for the bundle anchor, so an executing shell keeps the inode it started with.
 */
async function writeManagedFile(path: string, content: string, mode: number): Promise<boolean> {
  const existing = await readFile(path, 'utf8').catch(() => '');
  if (existing === content) return false;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.${process.pid}.pending`;
  await writeFile(pending, content, { mode });
  await chmod(pending, mode);
  await rename(pending, path);
  return true;
}

/** The message and stderr launchd's CLI wrote, for matching and reporting. */
function launchctlFailureText(error: unknown): string {
  return `${error instanceof Error ? error.message : String(error)}\n${
    (error as { stderr?: unknown } | null)?.stderr ?? ''
  }`;
}

async function launchdStatus(
  run: LaunchdRunner,
  target: string,
): Promise<{ pid: number; state: string; lastExitStatus?: number }> {
  try {
    const result = await run(['print', target]);
    const pid = Number(result.stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1] ?? '0');
    const state = result.stdout.match(/^\s*state\s*=\s*([^\n]+)$/m)?.[1]?.trim() ?? '';
    // launchd prints `(never exited)` until the job has exited once, so only a
    // numeric status is a recorded exit.
    const exited = Number(
      result.stdout.match(/^\s*last exit (?:status|code)\s*=\s*(-?\d+)\s*$/m)?.[1] ?? 'x',
    );
    return {
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : 0,
      state,
      ...(Number.isSafeInteger(exited) ? { lastExitStatus: exited } : {}),
    };
  } catch {
    return { pid: 0, state: 'unloaded' };
  }
}

/**
 * `bootout` inherits the daemon's whole drain, because the supervisor wrapper
 * forwards launchd's SIGTERM and waits: the generic 15-second command deadline
 * would kill the operator's `beeline stop` on exactly the busy agent the drain
 * exists for. launchd also answers `36: Operation now in progress` while the
 * job is still terminating, which is removal accepted, not a failure — but the
 * label is still in the domain until that teardown finishes, and launchd refuses
 * to bootstrap it meanwhile, so this waits the removal out before returning.
 */
async function bootoutIfLoaded(run: LaunchdRunner, target: string): Promise<void> {
  if ((await launchdStatus(run, target)).state === 'unloaded') return;
  try {
    await run(['bootout', target], { timeoutMs: LAUNCHD_STOP_TIMEOUT_MS });
    return;
  } catch (error) {
    if (!bootoutRemovalInProgress(error)) throw error;
  }
  const deadline = Date.now() + LAUNCHD_STOP_TIMEOUT_MS;
  do {
    if ((await launchdStatus(run, target)).state === 'unloaded') return;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`launchd did not finish removing ${target} before the stop deadline`);
}

function bootoutRemovalInProgress(error: unknown): boolean {
  return /failed:\s*36\b/.test(launchctlFailureText(error));
}

/**
 * launchd refuses to load a label it has not finished removing, and reports
 * that refusal with a numeric code rather than a phrase: `5: Input/output
 * error` and `37: Operation already in progress` are both the same
 * remove-then-load race seen at a different point in the teardown. A malformed
 * plist answers 5 as well, so this only ever bounds a retry — the refusal that
 * never clears is still reported, unchanged, by its caller.
 */
function bootstrapRefusedWhileRemoving(error: unknown): boolean {
  return /Bootstrap failed:\s*(?:5|36|37)\b/.test(launchctlFailureText(error));
}

/**
 * Install the machine helper job and make it host the current set of paired
 * agents. A running helper is sent SIGHUP to rescan: agents already serving
 * are not restarted. A job that is not loaded is bootstrapped. Every per-agent
 * job left from before the machine helper is retired first.
 */
export async function installLaunchdHelperService(
  options: {
    env?: NodeJS.ProcessEnv;
    run?: LaunchdRunner;
    waitTimeoutMs?: number;
    invocationPath?: string;
    /** The calling process's own legacy job, so retiring it comes last. */
    selfLabel?: string;
  } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  assertCanonicalInstalledLauncher(env, options.invocationPath);
  const home = launchdHome(env);
  await mkdir(resolve(home, 'Library', 'Logs', 'Beeline'), { recursive: true, mode: 0o700 });
  await writeManagedFile(launchdHelperSupervisorPath(env), launchdHelperSupervisorScript(), 0o700);
  const changed = await writeManagedFile(launchdHelperPlistPath(env), launchdHelperPlist(env), 0o600);
  const run = options.run ?? runLaunchctl;
  const domain = launchdUserDomain();
  const target = `${domain}/${LAUNCHD_HELPER_LABEL}`;
  // The helper starts before any per-agent job is retired: this may run inside
  // one of those jobs, and retiring it stops this very process.
  const retire = () => retireLegacyLaunchdAgents({
    env, run, ...(options.selfLabel ? { selfLabel: options.selfLabel } : {}),
  });
  const before = await launchdStatus(run, target);
  if (before.pid > 0 && !changed) {
    process.kill(before.pid, 'SIGHUP');
    await retire();
    return before.pid;
  }
  if (changed) await bootoutIfLoaded(run, target);
  await run(['enable', target]);
  if ((await launchdStatus(run, target)).state === 'unloaded') {
    const deadline = Date.now() + LAUNCHD_BOOTSTRAP_WAIT_MS;
    for (;;) {
      try {
        await run(['bootstrap', domain, launchdHelperPlistPath(env)]);
        break;
      } catch (error) {
        if (!bootstrapRefusedWhileRemoving(error) || Date.now() >= deadline) throw error;
        await sleep(LAUNCHD_BOOTSTRAP_RETRY_INTERVAL_MS);
      }
    }
  } else {
    await run(['kickstart', target]);
  }
  const deadline = Date.now() + (options.waitTimeoutMs ?? LAUNCHD_RESTART_WAIT_MS);
  do {
    const status = await launchdStatus(run, target);
    if (status.pid > 0 && (before.pid === 0 || status.pid !== before.pid)) {
      await retire();
      return status.pid;
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`launchd did not start ${LAUNCHD_HELPER_LABEL} before the restart deadline`);
}

/** Ask a running machine helper to rescan paired agents. */
export async function reloadLaunchdHelperService(
  options: { run?: LaunchdRunner } = {},
): Promise<boolean> {
  const run = options.run ?? runLaunchctl;
  const status = await launchdStatus(run, `${launchdUserDomain()}/${LAUNCHD_HELPER_LABEL}`);
  if (status.pid === 0) return false;
  process.kill(status.pid, 'SIGHUP');
  return true;
}

/**
 * Retire every per-agent job from before the machine helper: disabled, its
 * plist removed, and booted out without waiting for a drain. The calling
 * process's own job, if it is one of them, goes last.
 */
export async function retireLegacyLaunchdAgents(
  options: { env?: NodeJS.ProcessEnv; run?: LaunchdRunner; selfLabel?: string } = {},
): Promise<string[]> {
  const env = options.env ?? process.env;
  const run = options.run ?? runLaunchctl;
  const directory = resolve(launchdHome(env), 'Library', 'LaunchAgents');
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const match = /^app\.usebeeline\.agent\.([0-9a-f]{64})\.plist$/i;
  const labels = entries
    .map((entry) => match.exec(entry)?.[1]?.toLowerCase())
    .filter((key): key is string => Boolean(key))
    .map((key) => launchdAgentLabel(key))
    .sort((left, right) => Number(left === options.selfLabel) - Number(right === options.selfLabel));
  const domain = launchdUserDomain();
  for (const label of labels) {
    await run(['disable', `${domain}/${label}`]).catch(() => undefined);
    await rm(resolve(directory, `${label}.plist`), { force: true });
    await run(['bootout', `${domain}/${label}`]).catch(() => undefined);
  }
  return labels;
}

/**
 * A rollback restored a release that may predate the machine helper. Give each
 * paired agent its per-agent job back and stand the helper job down; a restored
 * release that knows the machine helper migrates straight back.
 */
export async function restoreLegacyLaunchdAgents(
  publicKeys: readonly string[],
  options: { env?: NodeJS.ProcessEnv; run?: LaunchdRunner } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const run = options.run ?? runLaunchctl;
  const domain = launchdUserDomain();
  await writeManagedFile(launchdAgentSupervisorPath(env), launchdAgentSupervisorScript(), 0o700);
  for (const publicKey of publicKeys) {
    if (!/^[0-9a-f]{64}$/i.test(publicKey)) continue;
    await writeManagedFile(launchdAgentPlistPath(publicKey, env), launchdAgentPlist(publicKey, env), 0o600);
    await run(['enable', `${domain}/${launchdAgentLabel(publicKey)}`]);
    await run(['bootstrap', domain, launchdAgentPlistPath(publicKey, env)]).catch((error) =>
      console.error(`[beeline] could not restore ${launchdAgentLabel(publicKey)}:`, error));
  }
  await run(['disable', `${domain}/${LAUNCHD_HELPER_LABEL}`]);
  await rm(launchdHelperPlistPath(env), { force: true });
}

/** A retired agent's per-agent job, if one is still installed, must not resurrect it. */
export async function cleanupLaunchdAgentService(
  publicKey: string,
  options: { env?: NodeJS.ProcessEnv; run?: LaunchdRunner } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const path = launchdAgentPlistPath(publicKey, env);
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const run = options.run ?? runLaunchctl;
  await run(['disable', `${launchdUserDomain()}/${launchdAgentLabel(publicKey)}`]);
  await rm(path, { force: true });
  return true;
}

export async function installLaunchdTrustySquireBrokerService(
  options: {
    env?: NodeJS.ProcessEnv;
    run?: LaunchdRunner;
    invocationPath?: string;
    restart?: boolean;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  assertCanonicalInstalledLauncher(env, options.invocationPath);
  const home = launchdHome(env);
  writeSquireBrokerUnitMarker(home);
  await mkdir(resolve(home, 'Library', 'Logs', 'Beeline'), { recursive: true, mode: 0o700 });
  const plistPath = launchdBrokerPlistPath(env);
  const changed = await writeManagedFile(plistPath, launchdBrokerPlist(env), 0o600);
  const run = options.run ?? runLaunchctl;
  const domain = launchdUserDomain();
  const target = `${domain}/${LAUNCHD_BROKER_LABEL}`;
  if (changed || options.restart) await bootoutIfLoaded(run, target);
  await run(['enable', target]);
  // `RunAtLoad` starts the job as part of bootstrap; a job that is still loaded
  // was not replaced here, so it is the one that needs starting.
  if ((await launchdStatus(run, target)).state === 'unloaded') {
    await run(['bootstrap', domain, plistPath]);
    return;
  }
  await run(['kickstart', target]);
}

export async function convergeLaunchdTrustySquireBrokerService(options: {
  libDir: string;
  env?: NodeJS.ProcessEnv;
  run?: LaunchdRunner;
  log?: (line: string) => void;
}): Promise<boolean> {
  const env = options.env ?? process.env;
  try {
    await installLaunchdTrustySquireBrokerService({
      env: { ...env, BEELINE_LIB_DIR: options.libDir },
      invocationPath: resolve(options.libDir, 'lib', 'beeline', 'beeline-cli.mjs'),
      restart: true,
      ...(options.run ? { run: options.run } : {}),
    });
    return true;
  } catch (error) {
    options.log?.(
      `[beeline] host Squire broker launchd job not converged: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
