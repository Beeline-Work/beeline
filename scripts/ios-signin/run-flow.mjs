import { spawn } from 'node:child_process';

// Maestro can hang inside a tap even when the flow's assertions have timeouts.
const [duration, command, ...args] = process.argv.slice(2);
const milliseconds = Number(duration);
if (!Number.isFinite(milliseconds) || milliseconds <= 0 || !command) {
  throw new Error('Usage: run-flow.mjs <milliseconds> <command> [args...]');
}
const child = spawn(command, args, { detached: true, stdio: 'inherit' });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`Capture flow timed out after ${milliseconds}ms; continuing with remaining captures`);
  process.kill(-child.pid, 'SIGKILL');
}, milliseconds);
child.on('error', error => {
  clearTimeout(timer);
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', code => {
  clearTimeout(timer);
  process.exitCode = timedOut ? 124 : (code ?? 1);
});
