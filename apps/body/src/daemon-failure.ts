import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DaemonApiError } from './daemon-api-client.js';
import { isNetworkFailure } from './live-link.js';

export const DAEMON_FAILURE_LIMIT = 3;
export const DAEMON_FAILURE_WINDOW_MS = 5 * 60_000;

interface DaemonFailureRecord {
  version: 1;
  failures: number[];
  lastError: string;
  distressedAt?: number;
}

export function daemonFailurePath(runtimeDir: string): string {
  return resolve(runtimeDir, 'daemon-distress.json');
}

async function readFailureRecord(runtimeDir: string): Promise<DaemonFailureRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(daemonFailurePath(runtimeDir), 'utf8')) as DaemonFailureRecord;
    if (
      value.version !== 1 ||
      !Array.isArray(value.failures) ||
      value.failures.some((failure) => typeof failure !== 'number') ||
      typeof value.lastError !== 'string'
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

async function writeFailureRecord(runtimeDir: string, record: DaemonFailureRecord): Promise<void> {
  const path = daemonFailurePath(runtimeDir);
  const staged = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(staged, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, path);
}

/**
 * Whether a start failure is one a restart cannot fix. A network failure, a
 * server that said "try again", and a 401 from a token that may still be
 * restored are all uncertainty: counting them stopped a helper for good on an
 * unhealthy box or a server outage.
 */
export function countsTowardDistress(error: unknown): boolean {
  if (isNetworkFailure(error)) return false;
  if (error instanceof DaemonApiError && (error.retryable || error.status === 401)) return false;
  return true;
}

export async function recordDaemonStartFailure(
  runtimeDir: string,
  error: unknown,
  now = Date.now(),
): Promise<{ distressed: boolean; count: number; path: string }> {
  const prior = await readFailureRecord(runtimeDir);
  const failures = [...(prior?.failures ?? []), now].filter(
    (failure) => now - failure <= DAEMON_FAILURE_WINDOW_MS,
  );
  const distressed = failures.length >= DAEMON_FAILURE_LIMIT;
  const record: DaemonFailureRecord = {
    version: 1,
    failures,
    lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
    ...(distressed ? { distressedAt: now } : {}),
  };
  await writeFailureRecord(runtimeDir, record);
  return { distressed, count: failures.length, path: daemonFailurePath(runtimeDir) };
}

/**
 * Settle one failed daemon run: only a failure a restart cannot fix is
 * counted, and three of those in the window mean distress (exit 77).
 */
export async function settleDaemonStartFailure(
  runtimeDir: string,
  error: unknown,
  now = Date.now(),
): Promise<{ distressed: boolean; count?: number; path?: string }> {
  if (!countsTowardDistress(error)) return { distressed: false };
  return recordDaemonStartFailure(runtimeDir, error, now);
}

/** A completed core establishment resets only start failures, never update evidence. */
export async function clearDaemonStartFailures(runtimeDir: string): Promise<void> {
  await rm(daemonFailurePath(runtimeDir), { force: true });
}
