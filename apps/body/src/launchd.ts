import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { defaultSupervisorRoot, runtimeConfigPath } from './runtime.js';
import {
  ensureSquireHostDir,
  SQUIRE_BROKER_FLAG,
  squireHostRewriteEnv,
} from './squire-host.js';
import {
  DAEMON_DISTRESS_EXIT_STATUS,
  DELIBERATE_REMOVAL_EXIT_STATUS,
  isCanonicalInstalledLauncher,
  UNKNOWN_AGENT_EXIT_STATUS,
} from './systemd.js';

const execFileAsync = promisify(execFile);

export const LAUNCHD_AGENT_LABEL_PREFIX = 'app.usebeeline.agent.';
export const LAUNCHD_BROKER_LABEL = 'app.usebeeline.trusty-squire-broker';
export const LAUNCHD_COMMAND_TIMEOUT_MS = 15_000;
export const LAUNCHD_RESTART_WAIT_MS = 10 * 60_000 + 30_000;
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
  return resolve(launchdHome(env), 'Library', 'LaunchAgents', `${launchdAgentLabel(publicKey)}.plist`);
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

export function launchdAgentPlist(
  publicKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
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
  const reported = `${error instanceof Error ? error.message : String(error)}\n${
    (error as { stderr?: unknown } | null)?.stderr ?? ''
  }`;
  return /failed:\s*36\b/.test(reported);
}

export async function installLaunchdAgentService(
  publicKey: string,
  options: {
    env?: NodeJS.ProcessEnv;
    run?: LaunchdRunner;
    waitTimeoutMs?: number;
    invocationPath?: string;
  } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  assertCanonicalInstalledLauncher(env, options.invocationPath);
  const home = launchdHome(env);
  const label = launchdAgentLabel(publicKey);
  const plistPath = launchdAgentPlistPath(publicKey, env);
  await mkdir(resolve(home, 'Library', 'Logs', 'Beeline'), { recursive: true, mode: 0o700 });
  await writeManagedFile(
    launchdAgentSupervisorPath(env),
    launchdAgentSupervisorScript(),
    0o700,
  );
  await writeManagedFile(plistPath, launchdAgentPlist(publicKey, env), 0o600);
  const run = options.run ?? runLaunchctl;
  const domain = launchdUserDomain();
  const target = `${domain}/${label}`;
  const before = await launchdStatus(run, target);
  await bootoutIfLoaded(run, target);
  await run(['enable', target]);
  // `RunAtLoad` starts the job as part of bootstrap, and the job was booted
  // out above, so there is nothing left for a `kickstart -k` to replace.
  await run(['bootstrap', domain, plistPath]);
  const deadline = Date.now() + (options.waitTimeoutMs ?? LAUNCHD_RESTART_WAIT_MS);
  do {
    const status = await launchdStatus(run, target);
    if (status.pid > 0 && (before.pid === 0 || status.pid !== before.pid)) return status.pid;
    // `KeepAlive.SuccessfulExit=false` leaves a job that exited 0 stopped
    // forever: the wrapper maps the deliberate terminal daemon statuses to 0,
    // so waiting out the restart deadline would report the wrong cause.
    if (status.pid === 0 && status.lastExitStatus === 0) {
      throw new Error(
        `launchd left ${label} stopped: the daemon exited with a deliberate terminal status`,
      );
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`launchd did not replace ${label}'s pid before the restart deadline`);
}

export async function disableLaunchdAgentService(
  publicKey: string,
  options: { env?: NodeJS.ProcessEnv; run?: LaunchdRunner; stop?: boolean } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const run = options.run ?? runLaunchctl;
  const label = launchdAgentLabel(publicKey);
  const target = `${launchdUserDomain()}/${label}`;
  await run(['disable', target]);
  // Retirement runs inside this job: leave that process alive long enough to
  // archive its runtime and exit with the deliberate terminal status. The
  // launchd wrapper maps that status to success, so KeepAlive leaves it down.
  if (options.stop !== false) await bootoutIfLoaded(run, target);
  await rm(launchdAgentPlistPath(publicKey, env), { force: true });
}

export async function cleanupLaunchdAgentService(
  publicKey: string,
  options: { env?: NodeJS.ProcessEnv; run?: LaunchdRunner } = {},
): Promise<boolean> {
  const path = launchdAgentPlistPath(publicKey, options.env ?? process.env);
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  await disableLaunchdAgentService(publicKey, { ...options, stop: false });
  return true;
}

export async function reconcileLaunchdAgentServices(
  options: {
    env?: NodeJS.ProcessEnv;
    run?: LaunchdRunner;
    hasRuntime?: (configPath: string) => Promise<boolean>;
    reportFailure?: (label: string, error: unknown) => void;
  } = {},
): Promise<string[]> {
  const env = options.env ?? process.env;
  const directory = resolve(launchdHome(env), 'Library', 'LaunchAgents');
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const match = /^app\.usebeeline\.agent\.([0-9a-f]{64})\.plist$/i;
  const hasRuntime =
    options.hasRuntime ??
    (async (path: string) => {
      try {
        await stat(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
  const reportFailure =
    options.reportFailure ??
    ((label: string, error: unknown) =>
      console.error(`[beeline] failed to reconcile orphan launchd job ${label}:`, error));
  const reconciled: string[] = [];
  for (const entry of entries) {
    const publicKey = match.exec(entry)?.[1]?.toLowerCase();
    if (!publicKey) continue;
    try {
      if (await hasRuntime(runtimeConfigPath(defaultSupervisorRoot(env), publicKey))) continue;
      // Heal the job definition, never the running process: this pass runs
      // inside a starting daemon, and booting out a live orphan (or this job
      // itself) waits out that agent's whole drain before anything else starts.
      await disableLaunchdAgentService(publicKey, {
        env,
        stop: false,
        ...(options.run ? { run: options.run } : {}),
      });
      reconciled.push(publicKey);
    } catch (error) {
      reportFailure(launchdAgentLabel(publicKey), error);
    }
  }
  return reconciled;
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
  ensureSquireHostDir(home);
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
