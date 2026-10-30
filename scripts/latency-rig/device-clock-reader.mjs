import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** One non-interactive shell for the capture; failed reads permanently retire it. */
export function createDeviceClockReader(device, { timeoutMs = 2000, spawnShell = spawn } = {}) {
  const child = spawnShell('adb', ['-s', device, 'shell', '-T'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  let pending;
  let failure;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1024); });
  const fail = (error) => {
    failure ??= error;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
    child.kill();
  };
  child.on('error', (error) => fail(new Error(`Device clock shell failed: ${error.message}`)));
  child.stdin.on('error', (error) => fail(new Error(`Device clock shell write failed: ${error.message}`)));
  child.on('close', (code, signal) => fail(new Error(`Device clock shell exited (${code ?? signal}): ${stderr.trim()}`)));
  lines.on('close', () => fail(new Error('Device clock shell output closed')));
  lines.on('line', (line) => {
    if (!pending || !/^\d+$/.test(line) || !Number.isSafeInteger(Number(line))) {
      fail(new Error(`Invalid device clock shell response: ${JSON.stringify(line)}`));
      return;
    }
    clearTimeout(pending.timer);
    pending.resolve(Number(line));
    pending = undefined;
  });
  return {
    read() {
      if (failure) return Promise.reject(failure);
      if (pending) return Promise.reject(new Error('Device clock read already pending'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error('Device clock shell read timed out')), timeoutMs);
        pending = { resolve, reject, timer };
        child.stdin.write('date +%s%3N\n');
      });
    },
    close() { fail(new Error('Device clock reader closed')); lines.close(); },
  };
}
