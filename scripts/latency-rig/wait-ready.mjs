import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export async function waitReady(port, { timeoutMs = 60000, pollMs = 100, alive = () => true } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!alive()) throw new Error(`Readiness failed: fixture exited before port ${port} was listening`);
    const ready = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const finish = (value) => { socket.destroy(); resolve(value); };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(Math.min(1000, Math.max(1, deadline - Date.now())), () => finish(false));
    });
    if (ready) return;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, deadline - Date.now()));
  } while (Date.now() <= deadline);
  throw new Error(`Readiness timed out after ${timeoutMs} ms: port ${port} is not listening`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pid = Number(process.argv[3]);
  await waitReady(Number(process.argv[2]), { timeoutMs: 180000,
    alive: () => { try { process.kill(pid, 0); return true; } catch { return false; } } });
}
