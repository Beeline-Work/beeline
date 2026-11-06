import type { Server } from 'node:http';

type StartupReporter = (message: string, detail: string) => void;

async function bestEffortPresenceRecovery(
  task: () => Promise<void>,
  report: StartupReporter = (message, detail) => console.error(message, detail),
): Promise<void> {
  try {
    await task();
  } catch (error) {
    report(
      '[startup] presence recovery unavailable; continuing',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function listenAfterBestEffortRecovery(
  server: Server,
  recovery: () => Promise<void>,
  port: number,
  host: string,
  report?: StartupReporter,
): Promise<void> {
  await bestEffortPresenceRecovery(recovery, report);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
