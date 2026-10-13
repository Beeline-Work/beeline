import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const DAEMON_FAILURE_WINDOW_MS = 5 * 60_000;
export function daemonFailurePath(runtimeDir: string): string {
  return resolve(runtimeDir, 'daemon-distress.json');
}
interface FailureDiagnostic {
  version: 1;
  failures: number[];
  lastError: string;
  recoveredAt?: number;
}
async function read(runtimeDir: string): Promise<FailureDiagnostic | undefined> {
  return readFile(daemonFailurePath(runtimeDir), 'utf8')
    .then((raw) => JSON.parse(raw) as FailureDiagnostic)
    .catch(() => undefined);
}
async function write(runtimeDir: string, record: FailureDiagnostic): Promise<void> {
  const path = daemonFailurePath(runtimeDir),
    temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
/** Legacy distress files become diagnostics only; no count may disable an agent. */
export async function recordDaemonStartFailure(
  runtimeDir: string,
  error: unknown,
  now = Date.now(),
): Promise<{ count: number; path: string }> {
  const prior = await read(runtimeDir);
  const failures = [...(prior?.failures ?? []), now].filter(
    (time) => now - time <= DAEMON_FAILURE_WINDOW_MS,
  );
  await write(runtimeDir, {
    version: 1,
    failures,
    lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
  });
  return { count: failures.length, path: daemonFailurePath(runtimeDir) };
}
export const settleDaemonStartFailure = recordDaemonStartFailure;
/** Reset the retry count after actual establishment while preserving the last error. */
export async function clearDaemonStartFailures(runtimeDir: string): Promise<void> {
  const prior = await read(runtimeDir);
  if (prior)
    await write(runtimeDir, {
      version: 1,
      failures: [],
      lastError: prior.lastError,
      recoveredAt: Date.now(),
    });
}
