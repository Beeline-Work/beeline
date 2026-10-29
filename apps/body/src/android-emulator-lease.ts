import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { closeSync, existsSync, openSync } from 'node:fs';
import { resolve } from 'node:path';

const FIRST_PORT = 5554;
const LAST_PORT = 5584;
const PORT_STEP = 4; // console, adb transport, then this instance's adb server

export interface EmulatorLease {
  port: number;
  serial: string;
  root: string;
  /** Port marker file. Its contents are `ownership` while this lease holds the port. */
  marker: string;
  /** Exact marker text this lease wrote, so a later release does not delete a replacement. */
  ownership: string;
  release(): Promise<void>;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Linux process start ticks distinguish a live PID from a reused lease owner. */
export async function processStart(pid: number): Promise<string | undefined> {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  if (raw) return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || undefined; }
  catch { return undefined; }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

/** An instance owns one port pair and one private writable data directory. */
export async function leaseEmulator(root: string, privateRoot: string): Promise<EmulatorLease> {
  const absolute = resolve(root);
  await Promise.all([
    mkdir(absolute, { recursive: true, mode: 0o700 }),
    mkdir(privateRoot, { recursive: true, mode: 0o700 }),
  ]);
  for (let port = FIRST_PORT; port <= LAST_PORT; port += PORT_STEP) {
    const marker = resolve(absolute, `port-${port}.lease`);
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await open(marker, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const old = await readFile(marker, 'utf8').catch(() => '');
        const [pidText, start] = old.split(':');
        const pid = Number(pidText);
        if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid)) {
          const currentStart = await processStart(pid);
          if (!currentStart || start === currentStart) break;
        }
        const before = await stat(marker).catch(() => undefined);
        // A newly created empty marker may still be awaiting its owner record.
        if (before && !old && Date.now() - before.mtimeMs < 10_000) break;
        if (!before || !(await portFree(port)) || !(await portFree(port + 1)) ||
            !(await portFree(port + 2))) break;
        const after = await stat(marker).catch(() => undefined);
        if (after && before.ino === after.ino && (await readFile(marker, 'utf8').catch(() => '')) === old)
          await rm(marker, { force: true });
      }
    }
    if (!handle) continue;
    const instance = resolve(privateRoot, `instance-${randomUUID()}`);
    const ownership = `${process.pid}:${await processStart(process.pid)}:${randomUUID()}:${instance}`;
    try {
      await handle.writeFile(ownership);
      await handle.sync();
      if (!(await portFree(port)) || !(await portFree(port + 1)) || !(await portFree(port + 2))) {
        await handle.close();
        if ((await readFile(marker, 'utf8').catch(() => '')) === ownership)
          await rm(marker, { force: true });
        continue;
      }
      await handle.close();
      await mkdir(instance, { recursive: true, mode: 0o700 });
      return {
        port,
        serial: `emulator-${port}`,
        root: instance,
        marker,
        ownership,
        release: async () => {
          if ((await readFile(marker, 'utf8').catch(() => '')) === ownership)
            await rm(marker, { force: true });
          await rm(instance, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      if ((await readFile(marker, 'utf8').catch(() => '')) === ownership)
        await rm(marker, { force: true });
      throw error;
    }
  }
  throw new Error('no Android emulator port is free in the installed 5554–5584 range');
}

/** `-help`, `-list-avds` and `-version` print and exit. They must not take a lease. */
export function emulatorArgsAreInfoOnly(args: readonly string[]): boolean {
  return !args.includes('-avd') && args.some((arg) =>
    arg === '-help' || arg === '--help' || arg.startsWith('-help-') ||
    arg === '-list-avds' || arg === '-version');
}

export interface SpawnedLeasedEmulator {
  lease: EmulatorLease;
  child: ChildProcess;
  /** Private AVD home passed to the emulator. Its userdata lives for the lease. */
  localAvdHome: string;
}

/**
 * Lease a port, copy AVD metadata, and spawn the emulator.
 * The caller decides whether the process is allowed to outlive this function.
 * A missing base AVD returns exit code 1 and takes no lease.
 */
export async function spawnLeasedEmulator(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { detached?: boolean; logPath?: string; leaseAdbServer?: boolean } = {},
): Promise<SpawnedLeasedEmulator | { exitCode: number }> {
  const leaseRoot = env.BEELINE_ANDROID_LEASE_ROOT;
  const privateRoot = env.BEELINE_ANDROID_INSTANCE_ROOT;
  const baseAvdHome = env.BEELINE_ANDROID_BASE_AVD_HOME;
  const emulator = env.BEELINE_ANDROID_EMULATOR_BINARY;
  if (!leaseRoot || !privateRoot || !baseAvdHome || !emulator)
    throw new Error('Beeline emulator lease environment is unavailable');
  const avdIndex = args.indexOf('-avd');
  const avdName = avdIndex >= 0 ? args[avdIndex + 1] : undefined;
  if (!avdName || !/^[a-zA-Z0-9_-]+$/.test(avdName))
    throw new Error('emulator requires -avd <name>');
  if (args.includes('-port') || args.includes('-datadir'))
    throw new Error('Beeline allocates emulator port and data directory');
  // A base AVD can be half made: its `<name>.ini` exists but the `.avd`
  // directory or its config.ini is missing (an interrupted `avdmanager
  // create`, or a deleted directory). Check before leasing so this clean
  // failure leaves no lease marker or instance directory behind, and report
  // it as a plain message instead of a captured helper error.
  const avdIni = resolve(baseAvdHome, `${avdName}.ini`);
  const avdConfig = resolve(baseAvdHome, `${avdName}.avd`, 'config.ini');
  const missing = !existsSync(avdIni) ? avdIni : !existsSync(avdConfig) ? avdConfig : undefined;
  if (missing) {
    console.error(
      `Base AVD "${avdName}" is incomplete: ${missing} is missing. ` +
      'Recreate it with `avdmanager create avd`, or pick one from `emulator -list-avds`.',
    );
    return { exitCode: 1 };
  }
  const lease = await leaseEmulator(leaseRoot, privateRoot);
  if (options.leaseAdbServer) {
    env = { ...env, ANDROID_ADB_SERVER_PORT: String(lease.port + 2),
      ANDROID_SERIAL: lease.serial, BEELINE_ANDROID_EMULATOR_PORT: String(lease.port), ADB_EMU: '0' };
    delete env.ADB_SERVER_SOCKET;
  }
  let child: ChildProcess | undefined;
  try {
    if (env.ANDROID_EMULATOR_HOME)
      await mkdir(env.ANDROID_EMULATOR_HOME, { recursive: true, mode: 0o700 });
    if (env.ANDROID_HOME) {
      const adb = resolve(env.ANDROID_HOME, 'platform-tools/adb');
      if (existsSync(adb)) execFileSync(adb, ['start-server'], { env, timeout: 15_000 });
    }
    const original = resolve(baseAvdHome, `${avdName}.avd`);
    const localAvdHome = resolve(lease.root, 'avd');
    const local = resolve(localAvdHome, `${avdName}.avd`);
    const data = resolve(lease.root, 'data');
    await mkdir(local, { recursive: true, mode: 0o700 });
    await mkdir(data, { recursive: true, mode: 0o700 });
    await cp(resolve(original, 'config.ini'), resolve(local, 'config.ini'));
    const metadata = await readFile(resolve(baseAvdHome, `${avdName}.ini`), 'utf8');
    await writeFile(resolve(localAvdHome, `${avdName}.ini`),
      metadata.replace(/^path\s*=.*$/m, `path=${local}`)
        .replace(/^path\.rel\s*=.*\n?/m, ''), { mode: 0o600 });
    const logPath = options.detached ? resolve(lease.root, 'emulator.log') : options.logPath;
    const logFd = logPath ? openSync(logPath, 'a') : undefined;
    try {
      child = spawn(emulator,
        [...args.filter((arg) => arg !== '-read-only'), '-port', String(lease.port), '-datadir', data],
        {
          env: { ...env, ANDROID_AVD_HOME: localAvdHome, ADB_EMU: '0' },
          detached: options.detached === true,
          stdio: logFd === undefined ? 'inherit' : ['ignore', logFd, logFd],
        });
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
    return { lease, child, localAvdHome };
  } catch (error) {
    if (child && child.pid) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    await lease.release();
    throw error;
  }
}

/** The one-shot CLI launcher keeps the lease alive until this exact emulator exits. */
export async function runLeasedEmulator(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const emulator = env.BEELINE_ANDROID_EMULATOR_BINARY;
  if (emulator && emulatorArgsAreInfoOnly(args)) {
    return new Promise<number>((done, reject) => {
      const child = spawn(emulator, args, { env, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => done(signal ? 1 : (code ?? 1)));
    });
  }
  const started = await spawnLeasedEmulator(args, env);
  if ('exitCode' in started) return started.exitCode;
  try {
    const status = await new Promise<number>((done, reject) => {
      started.child.once('error', reject);
      started.child.once('exit', (code, signal) => done(signal ? 1 : (code ?? 1)));
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => started.child.kill(signal));
    });
    return status;
  } finally {
    await started.lease.release();
  }
}
