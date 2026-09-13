import type { Server } from 'node:http';

const STARTUP_RECOVERY_TIMEOUT_MS = 3_000;

type StartupReporter = (message: string, detail: string) => void;

async function bestEffortPresenceRecovery(
  task: () => Promise<void>,
  timeoutMs = STARTUP_RECOVERY_TIMEOUT_MS,
  report: StartupReporter = (message, detail) => console.error(message, detail),
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    report(
      '[startup] presence recovery unavailable; continuing',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function listenAfterBestEffortRecovery(
  server: Server,
  recovery: () => Promise<void>,
  port: number,
  host: string,
  timeoutMs = STARTUP_RECOVERY_TIMEOUT_MS,
  report?: StartupReporter,
): Promise<void> {
  await bestEffortPresenceRecovery(recovery, timeoutMs, report);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
