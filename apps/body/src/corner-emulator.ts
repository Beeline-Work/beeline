/**
 * One Android emulator per corner, owned by the helper rather than the turn.
 *
 * The agent shell runs inside a pid namespace that dies with the turn, so an
 * emulator started there dies too and its lease is released. The helper listens
 * on an abstract socket and spawns the emulator detached. The process and its
 * userdata stay up for later turns of the same corner. Agent-home paths are
 * longer than a Unix socket name, and the sandbox hides /tmp, so the socket
 * is not a file.
 *
 * The helper seals the emulator binary, the SDK, and the lease and instance
 * paths when it opens the socket. Those values come from the corner
 * configuration the helper already computed. A request that names any of them
 * is rejected, so a client cannot point this process at another executable.
 * Client environment values never select the executable or lease paths.
 *
 * At most one emulator is kept per corner. Its lease owns its adb server too.
 * Each corner's adb launcher reads the kept record on every call, so later
 * turns and other agents use the same server and emulator serial. A later
 * start reuses that device instead of leasing a second one. The emulator stops when the corner closes or archives,
 * and on helper start when the corner is confirmed gone.
 */
import { execFileSync } from 'node:child_process';
import { createServer, createConnection, type Server } from 'node:net';
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import {
  processAlive,
  processStart,
  spawnLeasedEmulator,
  type EmulatorLease,
} from './android-emulator-lease.js';

/** Lease and SDK variables a corner shell needs in order to boot and select a device. */
export const ANDROID_LEASE_ENV_KEYS = [
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_EMULATOR_HOME',
  'ANDROID_AVD_HOME',
  'ANDROID_ADB_SERVER_PORT',
  'ANDROID_SERIAL',
  'ADB_EMU',
  'BEELINE_ANDROID_EMULATOR_PORT',
  'BEELINE_ANDROID_LEASE_ROOT',
  'BEELINE_ANDROID_INSTANCE_ROOT',
  'BEELINE_ANDROID_BASE_AVD_HOME',
  'BEELINE_ANDROID_EMULATOR_BINARY',
  'BEELINE_CORNER_EMULATOR_SOCKET',
  'BEELINE_CORNER_ID',
] as const;

/** Paths and process roots the helper owns. A socket request must not set these. */
const HOST_OWNED_ENV_KEYS = [
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_EMULATOR_HOME',
  'ANDROID_AVD_HOME',
  'BEELINE_ANDROID_LEASE_ROOT',
  'BEELINE_ANDROID_INSTANCE_ROOT',
  'BEELINE_ANDROID_BASE_AVD_HOME',
  'BEELINE_ANDROID_EMULATOR_BINARY',
  'PATH',
  'HOME',
  'TMPDIR',
] as const;

/** Per-agent adb wiring. Safe to take from the caller; it does not select a binary. */
const CLIENT_ENV_KEYS = [
  'ANDROID_ADB_SERVER_PORT',
  'ADB_EMU',
  'BEELINE_ANDROID_EMULATOR_PORT',
] as const;

const CORNER_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Executable, SDK, and lease paths captured from the helper's corner configuration. */
export interface CornerEmulatorHost {
  androidHome: string;
  emulatorBinary: string;
  leaseRoot: string;
  instanceRoot: string;
  baseAvdHome: string;
  sdkRoot?: string;
  emulatorHome?: string;
  avdHome?: string;
  path?: string;
  home?: string;
  tmpdir?: string;
}

export function cornerEmulatorHostFromEnv(
  env: Record<string, string | undefined>,
): CornerEmulatorHost | undefined {
  const androidHome = env.ANDROID_HOME;
  const emulatorBinary = env.BEELINE_ANDROID_EMULATOR_BINARY;
  const leaseRoot = env.BEELINE_ANDROID_LEASE_ROOT;
  const instanceRoot = env.BEELINE_ANDROID_INSTANCE_ROOT;
  const baseAvdHome = env.BEELINE_ANDROID_BASE_AVD_HOME;
  if (!androidHome || !emulatorBinary || !leaseRoot || !instanceRoot || !baseAvdHome)
    return undefined;
  return {
    androidHome,
    emulatorBinary,
    leaseRoot,
    instanceRoot,
    baseAvdHome,
    ...(env.ANDROID_SDK_ROOT ? { sdkRoot: env.ANDROID_SDK_ROOT } : {}),
    ...(env.ANDROID_EMULATOR_HOME ? { emulatorHome: env.ANDROID_EMULATOR_HOME } : {}),
    ...(env.ANDROID_AVD_HOME ? { avdHome: env.ANDROID_AVD_HOME } : {}),
    ...(env.PATH ? { path: env.PATH } : {}),
    ...(env.HOME ? { home: env.HOME } : {}),
    ...(env.TMPDIR ? { tmpdir: env.TMPDIR } : {}),
  };
}

/** Resolve helper paths once. The binary has to be that SDK's emulator. */
function sealHost(host: CornerEmulatorHost): NodeJS.ProcessEnv {
  const androidHome = resolve(host.androidHome);
  const emulatorBinary = resolve(host.emulatorBinary);
  if (emulatorBinary !== resolve(androidHome, 'emulator/emulator'))
    throw new Error('emulator binary is not the installed SDK emulator');
  return {
    ANDROID_HOME: androidHome,
    ANDROID_SDK_ROOT: resolve(host.sdkRoot ?? host.androidHome),
    BEELINE_ANDROID_LEASE_ROOT: resolve(host.leaseRoot),
    BEELINE_ANDROID_INSTANCE_ROOT: resolve(host.instanceRoot),
    BEELINE_ANDROID_BASE_AVD_HOME: resolve(host.baseAvdHome),
    BEELINE_ANDROID_EMULATOR_BINARY: emulatorBinary,
    ...(host.emulatorHome ? { ANDROID_EMULATOR_HOME: resolve(host.emulatorHome) } : {}),
    ...(host.avdHome ? { ANDROID_AVD_HOME: resolve(host.avdHome) } : {}),
    ...(host.path ? { PATH: host.path } : {}),
    ...(host.home ? { HOME: host.home } : {}),
    ...(host.tmpdir ? { TMPDIR: host.tmpdir } : {}),
  };
}

/** Abstract name. A filesystem path under the agent home does not fit in `sun_path`. */
export function cornerEmulatorSocketName(cornerId: string): string {
  if (!CORNER_ID.test(cornerId)) throw new Error('invalid corner id');
  return `@beeline-emu-${cornerId}`;
}

function socketAddress(socketPath: string): string {
  return socketPath.startsWith('@') ? `\0${socketPath.slice(1)}` : socketPath;
}
const BOOT_TIMEOUT_MS = 240_000;
const listeners = new Map<string, { server: Server; host: CornerEmulatorHost }>();
const cornerGates = new Map<string, Promise<void>>();

export interface KeptCornerEmulator {
  version: 1;
  cornerId: string;
  pid: number;
  startedAt?: string;
  port: number;
  serial: string;
  instanceRoot: string;
  markerPath: string;
  ownership: string;
  adbServerPort?: string;
  androidHome?: string;
  leaseRoot: string;
}

export function androidLeaseShellBindings(
  env: Record<string, string | undefined>,
): { name: string; value: string }[] {
  // A corner without the shared emulator lease keeps the task shell's exact
  // env. Host SDK variables must not leak into it.
  if (!env.BEELINE_ANDROID_LEASE_ROOT) return [];
  const bindings: { name: string; value: string }[] = ANDROID_LEASE_ENV_KEYS.flatMap((name) => {
    const value = env[name];
    return value ? [{ name, value }] : [];
  });
  // The task shell's default PATH has no SDK bins. Add this turn's PATH only
  // with the lease, so a corner without one keeps its exact shell env.
  if (env.ANDROID_HOME && env.PATH) bindings.push({ name: 'PATH', value: env.PATH });
  return bindings;
}

function keptDir(leaseRoot: string): string {
  return resolve(leaseRoot, 'kept');
}

function recordPath(leaseRoot: string, cornerId: string): string {
  if (!CORNER_ID.test(cornerId)) throw new Error('invalid corner id');
  return resolve(keptDir(leaseRoot), `${cornerId}.json`);
}

async function readRecord(leaseRoot: string, cornerId: string): Promise<KeptCornerEmulator | undefined> {
  const raw = await readFile(recordPath(leaseRoot, cornerId), 'utf8').catch(() => undefined);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as KeptCornerEmulator;
    if (parsed?.version !== 1 || parsed.cornerId !== cornerId || !Number.isInteger(parsed.pid))
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Resolve the lease on every adb call, including an emulator booted during this turn. */
export async function prepareCornerAdb(
  root: string,
  cornerId: string,
  env: Record<string, string>,
): Promise<void> {
  const leaseRoot = env.BEELINE_ANDROID_LEASE_ROOT;
  if (!leaseRoot || !env.ANDROID_HOME) return;
  const kept = await readRecord(leaseRoot, cornerId);
  if (kept && await sameProcess(kept.pid, kept.startedAt)) {
    env.ANDROID_SERIAL = kept.serial;
    if (kept.adbServerPort) env.ANDROID_ADB_SERVER_PORT = kept.adbServerPort;
    env.BEELINE_ANDROID_EMULATOR_PORT = String(kept.port);
    removeLegacyAdbAlias(kept, env.ANDROID_HOME);
  }
  const bin = resolve(root, 'corner-adb-bin');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const launcher = resolve(bin, 'adb');
  await writeFile(launcher, `#!${process.execPath}
const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const env = { ...process.env };
try {
  const record = JSON.parse(readFileSync(${JSON.stringify(recordPath(leaseRoot, cornerId))}, 'utf8'));
  if (record.version === 1 && record.cornerId === ${JSON.stringify(cornerId)}) {
    env.ANDROID_SERIAL = record.serial;
    if (record.adbServerPort) env.ANDROID_ADB_SERVER_PORT = record.adbServerPort;
    delete env.ADB_SERVER_SOCKET;
  }
} catch (error) {
  if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
}
const child = spawn(${JSON.stringify(resolve(env.ANDROID_HOME, 'platform-tools/adb'))}, process.argv.slice(2), { env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code; });
`, { mode: 0o700 });
  await chmod(launcher, 0o700);
  env.PATH = [bin, env.PATH].filter(Boolean).join(delimiter);
}

/** Earlier helpers registered both an emulator transport and a duplicate TCP alias. */
function removeLegacyAdbAlias(record: KeptCornerEmulator, androidHome: string): void {
  if (record.adbServerPort === String(record.port + 2)) return;
  const adb = resolve(androidHome, 'platform-tools/adb');
  if (!existsSync(adb)) return;
  const env: NodeJS.ProcessEnv = { ...process.env, ANDROID_ADB_SERVER_PORT: record.adbServerPort };
  delete env.ADB_SERVER_SOCKET;
  try {
    execFileSync(adb, ['disconnect', `127.0.0.1:${record.port + 1}`], {
      env, timeout: 5_000, stdio: 'ignore',
    });
  } catch { /* The alias may already be gone. */ }
}

async function writeRecord(record: KeptCornerEmulator): Promise<void> {
  const path = recordPath(record.leaseRoot, record.cornerId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
  await rename(tmp, path);
}

async function sameProcess(pid: number, startedAt: string | undefined): Promise<boolean> {
  if (!processAlive(pid)) return false;
  if (!startedAt) return true;
  const current = await processStart(pid);
  return !current || current === startedAt;
}

async function killProcessGroup(pid: number): Promise<void> {
  const signal = (name: 'SIGTERM' | 'SIGKILL') => {
    // The emulator can leave the group it was spawned in. Signal both.
    try { process.kill(-pid, name); } catch { /* group already gone */ }
    try { process.kill(pid, name); } catch { /* already gone */ }
  };
  const gone = async () => {
    for (let i = 0; i < 25; i++) {
      if (!processAlive(pid)) return true;
      await new Promise((done) => setTimeout(done, 100));
    }
    return !processAlive(pid);
  };
  signal('SIGTERM');
  if (await gone()) return;
  signal('SIGKILL');
  await gone();
}

function disconnectAdb(record: KeptCornerEmulator): void {
  const home = record.androidHome ?? process.env.ANDROID_HOME;
  if (!home) return;
  const adb = resolve(home, 'platform-tools/adb');
  if (!existsSync(adb)) return;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(record.adbServerPort ? { ANDROID_ADB_SERVER_PORT: record.adbServerPort } : {}),
  };
  delete env.ADB_SERVER_SOCKET;
  try {
    execFileSync(adb, record.adbServerPort === String(record.port + 2)
      ? ['kill-server'] : ['disconnect', `127.0.0.1:${record.port + 1}`], {
      env, timeout: 5_000, stdio: 'ignore',
    });
  } catch {
    // The transport is already gone.
  }
}

/** Bytes of `emulator.log` kept per stop, and stop logs kept per lease root. */
const RETAINED_LOG_BYTES = 256 * 1024;
const RETAINED_LOG_COUNT = 20;

/** Where stopped emulators' logs survive, outside the deleted instance directory. */
export function stoppedEmulatorLogDir(leaseRoot: string): string {
  return resolve(leaseRoot, 'stopped');
}

async function logTail(path: string): Promise<string> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return '';
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, RETAINED_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Keep the stop reason and the log tail before the instance directory goes,
 * so the corner can still read why its emulator died. Oldest files beyond
 * the retention count are removed.
 */
async function retainStopLog(record: KeptCornerEmulator, reason: string, wasRunning: boolean): Promise<void> {
  const dir = stoppedEmulatorLogDir(record.leaseRoot);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stoppedAt = new Date().toISOString();
  const header = `${stoppedAt} corner=${record.cornerId} serial=${record.serial} pid=${record.pid}` +
    ` running=${wasRunning} reason=${reason.replace(/\s+/g, ' ')}\n`;
  const tail = await logTail(resolve(record.instanceRoot, 'emulator.log'));
  const name = `${record.cornerId}-${stoppedAt.replace(/[:.]/g, '-')}-${record.pid}.log`;
  await writeFile(resolve(dir, name), `${header}--- emulator.log tail ---\n${tail}`, { mode: 0o600 });
  const logs = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith('.log'));
  const stamped = await Promise.all(logs.map(async (file) => ({
    file,
    mtimeMs: (await stat(resolve(dir, file)).catch(() => undefined))?.mtimeMs ?? 0,
  })));
  stamped.sort((left, right) => right.mtimeMs - left.mtimeMs);
  await Promise.all(stamped.slice(RETAINED_LOG_COUNT).map(({ file }) =>
    rm(resolve(dir, file), { force: true })));
}

/** Releases in progress here, so the killed child's exit does not log a second stop. */
const releasing = new Set<string>();

async function releaseRecord(record: KeptCornerEmulator, reason: string): Promise<void> {
  const key = `${record.instanceRoot}:${record.pid}`;
  if (releasing.has(key)) return;
  releasing.add(key);
  try {
    await releaseRecordOnce(record, reason);
  } finally {
    releasing.delete(key);
  }
}

async function releaseRecordOnce(record: KeptCornerEmulator, reason: string): Promise<void> {
  const current = await readRecord(record.leaseRoot, record.cornerId);
  if (current && current.pid !== record.pid) return;
  // An earlier release already removed both; the child's later exit is not a second stop.
  if (!current && !existsSync(record.instanceRoot)) return;
  const running = await sameProcess(record.pid, record.startedAt);
  if (running) await killProcessGroup(record.pid);
  disconnectAdb(record);
  if ((await readFile(record.markerPath, 'utf8').catch(() => '')) === record.ownership)
    await rm(record.markerPath, { force: true });
  await retainStopLog(record, reason, running).catch((error) => {
    console.error(`[body] corner ${record.cornerId} emulator log could not be kept:`, error);
  });
  console.log(`[body] corner ${record.cornerId} emulator ${record.serial} released: ${reason}`);
  await rm(record.instanceRoot, { recursive: true, force: true });
  const latest = await readRecord(record.leaseRoot, record.cornerId);
  if (!latest || latest.pid === record.pid)
    await rm(recordPath(record.leaseRoot, record.cornerId), { force: true });
}

async function withCornerGate<T>(cornerId: string, body: () => Promise<T>): Promise<T> {
  const previous = cornerGates.get(cornerId) ?? Promise.resolve();
  let release!: () => void;
  const gate = previous.catch(() => undefined).then(() => new Promise<void>((done) => { release = done; }));
  cornerGates.set(cornerId, gate);
  await previous.catch(() => undefined);
  try {
    return await body();
  } finally {
    release();
    if (cornerGates.get(cornerId) === gate) cornerGates.delete(cornerId);
  }
}

function forwardedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CLIENT_ENV_KEYS) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

async function waitUntilBooted(
  env: NodeJS.ProcessEnv,
  serial: string,
  pid: number,
): Promise<boolean> {
  const adb = env.ANDROID_HOME ? resolve(env.ANDROID_HOME, 'platform-tools/adb') : '';
  if (!adb || !existsSync(adb)) return processAlive(pid);
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return false;
    try {
      const state = execFileSync(adb, ['-s', serial, 'get-state'], {
        env, timeout: 5_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (state === 'device') return true;
    } catch {
      // The device is not registered yet. The emulator retries its adb server.
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  return false;
}

function recordFromLease(
  cornerId: string,
  lease: EmulatorLease,
  pid: number,
  startedAt: string | undefined,
  env: NodeJS.ProcessEnv,
  leaseRoot: string,
): KeptCornerEmulator {
  return {
    version: 1,
    cornerId,
    pid,
    ...(startedAt ? { startedAt } : {}),
    port: lease.port,
    serial: lease.serial,
    instanceRoot: lease.root,
    markerPath: lease.marker,
    ownership: lease.ownership,
    ...(env.ANDROID_ADB_SERVER_PORT ? { adbServerPort: env.ANDROID_ADB_SERVER_PORT } : {}),
    ...(env.ANDROID_HOME ? { androidHome: env.ANDROID_HOME } : {}),
    leaseRoot,
  };
}

export type KeptEmulatorResult =
  | { ok: true; serial: string; port: number; alreadyRunning: boolean }
  | { ok: false; exitCode: number; error: string };

/**
 * Start the corner's emulator, or return the one already running.
 * The spawned process is detached from this caller, so the caller's exit
 * does not stop it or release its lease.
 * `host` is the helper's corner configuration. It replaces any executable,
 * SDK, or lease path on `env`.
 */
export async function keepCornerEmulator(
  cornerId: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  host: CornerEmulatorHost,
): Promise<KeptEmulatorResult> {
  if (!CORNER_ID.test(cornerId)) return { ok: false, exitCode: 1, error: 'invalid corner id' };
  let sealed: NodeJS.ProcessEnv;
  try {
    sealed = sealHost(host);
  } catch (error) {
    return { ok: false, exitCode: 1, error: error instanceof Error ? error.message : String(error) };
  }
  const bound: NodeJS.ProcessEnv = { ...env, ...sealed };
  const leaseRoot = bound.BEELINE_ANDROID_LEASE_ROOT;
  if (!leaseRoot) return { ok: false, exitCode: 1, error: 'Beeline emulator lease environment is unavailable' };
  const binary = bound.BEELINE_ANDROID_EMULATOR_BINARY;
  const expected = bound.ANDROID_HOME ? resolve(bound.ANDROID_HOME, 'emulator/emulator') : '';
  if (!binary || resolve(binary) !== expected)
    return { ok: false, exitCode: 1, error: 'emulator binary is not the installed SDK emulator' };
  return withCornerGate(cornerId, async () => {
    const existing = await readRecord(leaseRoot, cornerId);
    if (existing && await sameProcess(existing.pid, existing.startedAt)) {
      removeLegacyAdbAlias(existing, bound.ANDROID_HOME!);
      return { ok: true, serial: existing.serial, port: existing.port, alreadyRunning: true };
    }
    if (existing) await releaseRecord(existing, 'process was gone at the next start; its exit was not observed');
    const started = await spawnLeasedEmulator(args, bound, { detached: true, leaseAdbServer: true });
    if ('exitCode' in started)
      return { ok: false, exitCode: started.exitCode, error: 'emulator did not start' };
    const pid = started.child.pid;
    if (!pid) {
      await started.lease.release();
      return { ok: false, exitCode: 1, error: 'emulator did not start' };
    }
    const startedAt = await processStart(pid);
    bound.ANDROID_ADB_SERVER_PORT = String(started.lease.port + 2);
    const record = recordFromLease(cornerId, started.lease, pid, startedAt, bound, leaseRoot);
    await writeRecord(record);
    started.child.once('error', () => undefined);
    let bootPending = true;
    let exitReason: string | undefined;
    started.child.once('exit', (code, signal) => {
      exitReason = `emulator exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`;
      // The boot attempt owns cleanup until it has consumed the diagnostic.
      if (bootPending) return;
      void releaseRecord(record, exitReason).catch((error) => {
        console.error(`[body] corner ${cornerId} emulator cleanup failed:`, error);
      });
    });
    started.child.unref();
    const booted = await waitUntilBooted(bound, record.serial, pid);
    if (!booted) {
      // Read before cleanup removes the instance directory and its log.
      const diagnostic = await readFile(resolve(record.instanceRoot, 'emulator.log'), 'utf8').catch(() => '');
      await releaseRecord(record, `boot failed: ${exitReason ?? `Android did not finish booting within ${BOOT_TIMEOUT_MS / 1000}s`}`);
      return { ok: false, exitCode: 1, error: `emulator ${record.serial} exited before Android finished booting${diagnostic ? `\n${diagnostic.slice(-8192).trim()}` : ''}` };
    }
    bootPending = false;
    return { ok: true, serial: record.serial, port: record.port, alreadyRunning: false };
  });
}

/** Stop the corner's emulator and release its port, if a record exists. `reason` is kept with its log. */
export async function stopKeptCornerEmulator(
  supervisorRoot: string,
  cornerId: string,
  reason: string,
): Promise<boolean> {
  if (!CORNER_ID.test(cornerId)) return false;
  const records = await findKeptRecords(supervisorRoot, cornerId);
  if (!records.length) return false;
  await Promise.all(records.map((record) => releaseRecord(record, reason)));
  return true;
}

async function findKeptRecords(supervisorRoot: string, cornerId?: string): Promise<KeptCornerEmulator[]> {
  const workspaces = resolve(supervisorRoot, 'beeline', 'workspaces');
  const homes = await readdir(workspaces).catch(() => [] as string[]);
  const records: KeptCornerEmulator[] = [];
  for (const home of homes) {
    const dir = resolve(workspaces, home, 'shared-home', 'cache', 'android-leases', 'kept');
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      if (cornerId && file !== `${cornerId}.json`) continue;
      const raw = await readFile(resolve(dir, file), 'utf8').catch(() => undefined);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as KeptCornerEmulator;
        if (parsed?.version === 1 && parsed.cornerId && parsed.leaseRoot) records.push(parsed);
      } catch {
        // A half-written record is ignored until the next start rewrites it.
      }
    }
  }
  return records;
}

/** Whether a kept emulator's corner is closed, and why, for the stop log. */
export interface CornerClosedDecision {
  closed: boolean;
  reason: string;
}

/**
 * On helper start, stop emulators whose corners are confirmed closed.
 * `confirmClosed` must be false when the lookup fails or the caller is not
 * a member: a live corner another agent still has stays up.
 */
export async function reapKeptCornerEmulators(
  supervisorRoot: string,
  liveCornerIds: ReadonlySet<string>,
  confirmClosed: (cornerId: string) => Promise<CornerClosedDecision>,
): Promise<string[]> {
  const stopped: string[] = [];
  for (const record of await findKeptRecords(supervisorRoot)) {
    if (liveCornerIds.has(record.cornerId)) continue;
    let decision: CornerClosedDecision;
    try {
      decision = await confirmClosed(record.cornerId);
    } catch (error) {
      decision = { closed: false, reason: `lookup failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!decision.closed) continue;
    await releaseRecord(record, decision.reason);
    stopped.push(record.cornerId);
  }
  return stopped;
}

type KeepRequest = { cornerId?: unknown; args?: unknown; env?: unknown };

function parseRequest(line: string): { cornerId: string; args: string[]; env: NodeJS.ProcessEnv } | { error: string } {
  let parsed: KeepRequest;
  try {
    parsed = JSON.parse(line) as KeepRequest;
  } catch {
    return { error: 'invalid emulator request' };
  }
  if (typeof parsed.cornerId !== 'string' || !CORNER_ID.test(parsed.cornerId))
    return { error: 'invalid corner id' };
  if (!Array.isArray(parsed.args) || parsed.args.some((arg) => typeof arg !== 'string' || arg.length > 512))
    return { error: 'invalid emulator arguments' };
  const source = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
    ? parsed.env as Record<string, unknown>
    : {};
  for (const key of HOST_OWNED_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key))
      return { error: 'emulator paths are owned by the helper' };
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of CLIENT_ENV_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (typeof value !== 'string' || value.length === 0 || value.length >= 16_384)
      return { error: 'invalid emulator environment' };
    env[key] = value;
  }
  return { cornerId: parsed.cornerId, args: parsed.args as string[], env };
}

/** Listen in the helper. The socket is unref'd so it does not keep a process alive by itself. */
export async function listenCornerEmulator(
  socketPath: string,
  cornerId: string | undefined,
  host: CornerEmulatorHost,
): Promise<void> {
  if (listeners.has(socketPath)) return;
  if (cornerId && !CORNER_ID.test(cornerId)) throw new Error('invalid corner id');
  // Fail before binding the socket when the helper's own paths are inconsistent.
  sealHost(host);
  const abstract = socketPath.startsWith('@');
  if (!abstract) {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await unlink(socketPath).catch(() => undefined);
  }
  const server = createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 1_000_000) {
        socket.end(`${JSON.stringify({ ok: false, exitCode: 1, error: 'request too large' })}\n`);
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      void Promise.resolve(parseRequest(line)).then((request) => {
        if ('error' in request) return { ok: false as const, exitCode: 1, error: request.error };
        if (cornerId && request.cornerId !== cornerId)
          return { ok: false as const, exitCode: 1, error: 'corner emulator socket is for a different corner' };
        return keepCornerEmulator(request.cornerId, request.args, request.env, host);
      }).then((response) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!socket.destroyed)
          socket.end(`${JSON.stringify({ ok: false, exitCode: 1, error: message })}\n`);
      });
    });
  });
  await new Promise<void>((done, reject) => {
    const fail = (error: Error) => {
      server.close(() => undefined);
      reject(error);
    };
    server.once('error', fail);
    server.listen(socketAddress(socketPath), () => {
      server.removeListener('error', fail);
      done();
    });
  });
  if (!abstract) await chmod(socketPath, 0o600);
  server.unref();
  listeners.set(socketPath, { server, host });
}

export async function closeCornerEmulatorListeners(): Promise<void> {
  await Promise.all([...listeners.entries()].map(async ([path, listener]) => {
    listeners.delete(path);
    await new Promise<void>((done) => listener.server.close(() => done()));
    if (!path.startsWith('@')) await unlink(path).catch(() => undefined);
  }));
}

/** What `beeline emulator` runs when this corner has a helper socket. */
export async function requestKeptCornerEmulator(
  socketPath: string,
  cornerId: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const payload = JSON.stringify({ cornerId, args, env: forwardedEnv(env) });
  const response = await new Promise<KeptEmulatorResult>((done, reject) => {
    const socket = createConnection(socketAddress(socketPath));
    let buf = '';
    socket.setEncoding('utf8');
    socket.once('error', () => reject(new Error('corner emulator supervisor is not running')));
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      socket.end();
      try {
        done(JSON.parse(buf.slice(0, nl)) as KeptEmulatorResult);
      } catch (error) {
        reject(error);
      }
    });
    socket.write(`${payload}\n`);
  });
  if (!response.ok) {
    console.error(response.error);
    return response.exitCode;
  }
  console.log(`emulator ${response.serial}${response.alreadyRunning ? ' already running' : ' started'}`);
  return 0;
}
