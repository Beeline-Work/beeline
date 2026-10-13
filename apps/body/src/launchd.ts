import { assertLifecycleTestIsolation } from './lifecycle-test-guard.js';
import { nativeHelperPlist, convergeNativeHelper } from './native-helper.js';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  SQUIRE_BROKER_FLAG,
  squireHostRewriteEnv,
  updateSquireBrokerInstall,
  writeSquireBrokerUnitMarker,
  type SquireInstallRunner,
} from './squire-host.js';
import { isCanonicalInstalledLauncher } from './systemd.js';

const execFileAsync = promisify(execFile);

/** Pre-machine per-agent jobs; migration still names them. */
export const LAUNCHD_AGENT_LABEL_PREFIX = 'app.usebeeline.agent.';
/** One helper job per machine hosts every paired agent. */
export const LAUNCHD_HELPER_LABEL = 'app.usebeeline.helper';
export const LAUNCHD_BROKER_LABEL = 'app.usebeeline.trusty-squire-broker';
export const LAUNCHD_COMMAND_TIMEOUT_MS = 15_000;
/** Matches the common native 90-second stop ceiling. */
export const LAUNCHD_EXIT_TIMEOUT_SECONDS = 90;
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

/** The native helper job directly execs the recovery launcher; every exit restarts. */
export function launchdHelperPlist(env: NodeJS.ProcessEnv = process.env): string {
  return nativeHelperPlist(env);
}

export function launchdBrokerPlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(launchdHome(env), 'Library', 'LaunchAgents', `${LAUNCHD_BROKER_LABEL}.plist`);
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
  throw new Error(
    `launchd removal of ${target} is still in progress; retry this explicit operation`,
  );
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
  assertLifecycleTestIsolation(env, Boolean(options.run));
  assertCanonicalInstalledLauncher(env, options.invocationPath);
  return convergeNativeHelper({
    env,
    platform: 'launchd',
    ...(options.run ? { run: options.run } : {}),
    ...(options.selfLabel ? { legacyCaller: options.selfLabel } : {}),
  });
}

/** Ask a running machine helper to rescan paired agents. */
export async function reloadLaunchdHelperService(
  options: { run?: LaunchdRunner } = {},
): Promise<boolean> {
  assertLifecycleTestIsolation(process.env, Boolean(options.run));
  const run = options.run ?? runLaunchctl;
  const status = await launchdStatus(run, `${launchdUserDomain()}/${LAUNCHD_HELPER_LABEL}`);
  if (status.pid === 0) return false;
  process.kill(status.pid, 'SIGHUP');
  return true;
}

/** A retired agent's per-agent job, if one is still installed, must not resurrect it. */
export async function cleanupLaunchdAgentService(
  publicKey: string,
  options: { env?: NodeJS.ProcessEnv; run?: LaunchdRunner } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  assertLifecycleTestIsolation(env, Boolean(options.run));
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
    squireInstallRun?: SquireInstallRunner;
    squireUpdateMode?: 'latest' | 'minimum';
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  assertLifecycleTestIsolation(env, Boolean(options.run));
  assertCanonicalInstalledLauncher(env, options.invocationPath);
  const home = launchdHome(env);
  writeSquireBrokerUnitMarker(home);
  const install = await updateSquireBrokerInstall(home, {
    ...(options.squireInstallRun ? { run: options.squireInstallRun } : {}),
    mode: options.squireUpdateMode ?? 'latest',
  });
  await mkdir(resolve(home, 'Library', 'Logs', 'Beeline'), { recursive: true, mode: 0o700 });
  const plistPath = launchdBrokerPlistPath(env);
  const changed = await writeManagedFile(plistPath, launchdBrokerPlist(env), 0o600);
  const run = options.run ?? runLaunchctl;
  const domain = launchdUserDomain();
  const target = `${domain}/${LAUNCHD_BROKER_LABEL}`;
  if (changed || install.changed || options.restart) await bootoutIfLoaded(run, target);
  await run(['enable', target]);
  // `RunAtLoad` starts the job as part of bootstrap; a job that is still loaded
  // was not replaced here, so it is the one that needs starting.
  if ((await launchdStatus(run, target)).state === 'unloaded') {
    await run(['bootstrap', domain, plistPath]);
    return;
  }
  await run(['kickstart', target]);
}
