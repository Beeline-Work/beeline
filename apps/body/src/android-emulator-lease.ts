import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const FIRST_PORT = 5554;
const LAST_PORT = 5584;
const PORT_STEP = 4; // console, adb transport, then this instance's adb server

export interface EmulatorLease {
  port: number;
  serial: string;
  root: string;
  release(): Promise<void>;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Linux process start ticks distinguish a live PID from a reused lease owner. */
async function processStart(pid: number): Promise<string | undefined> {
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

/** The CLI launcher keeps the lease alive until this exact emulator exits. */
export async function runLeasedEmulator(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
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
  const lease = await leaseEmulator(leaseRoot, privateRoot);
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
    const status = await new Promise<number>((done, reject) => {
      const child = spawn(emulator,
        [...args.filter((arg) => arg !== '-read-only'), '-port', String(lease.port), '-datadir', data],
        {
          env: { ...env, ANDROID_AVD_HOME: localAvdHome, ADB_EMU: '0' },
          stdio: 'inherit',
        });
      child.once('error', reject);
      child.once('exit', (code, signal) => done(signal ? 1 : (code ?? 1)));
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => child.kill(signal));
    });
    return status;
  } finally {
    await lease.release();
  }
}
