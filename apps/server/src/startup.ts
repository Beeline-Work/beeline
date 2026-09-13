import type { Server } from 'node:http';

export const STARTUP_DEPENDENCY_TIMEOUT_MS = 3_000;

type StartupReporter = (message: string, detail: string) => void;

export async function bestEffortStartup<T>(
  label: string,
  task: () => Promise<T>,
  timeoutMs = STARTUP_DEPENDENCY_TIMEOUT_MS,
  report: StartupReporter = (message, detail) => console.error(message, detail),
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    report(
      `[startup] ${label} unavailable; continuing`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function listenAfterBestEffortRecovery(
  server: Server,
  recovery: () => Promise<void>,
  port: number,
  host: string,
  timeoutMs = STARTUP_DEPENDENCY_TIMEOUT_MS,
  report?: StartupReporter,
): Promise<void> {
  await bestEffortStartup('presence recovery', recovery, timeoutMs, report);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
