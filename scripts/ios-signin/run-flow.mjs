import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

function preserveStall() {
  const { CAPTURE_DEVICE: device, CAPTURE_STALL_DIR: directory } = process.env;
  if (!device || !directory) return;
  mkdirSync(directory, { recursive: true });
  const predicate = 'process CONTAINS[c] "Beeline" OR process CONTAINS[c] "buzzy" OR process CONTAINS[c] "ASWebAuthenticationSession" OR process == "SafariViewService" OR process == "SpringBoard" OR subsystem CONTAINS[c] "AuthenticationServices"';
  const commands = [
    ['screenshot.log', 'xcrun', ['simctl', 'io', device, 'screenshot', join(directory, 'screen.png')]],
    ['device-last-60s.log', 'xcrun', ['simctl', 'spawn', device, 'log', 'show', '--last', '60s', '--style', 'compact', '--predicate', predicate]],
    ['maestro-hierarchy.txt', 'maestro', ['--device', device, 'hierarchy']],
  ];
  for (const [filename, tool, toolArgs] of commands) {
    const output = openSync(join(directory, filename), 'w');
    try {
      const result = spawnSync(tool, toolArgs, { stdio: ['ignore', output, output], timeout: 15000, killSignal: 'SIGKILL' });
      appendFileSync(join(directory, 'diagnostics.txt'), `${tool} ${toolArgs.join(' ')}: status=${result.status} signal=${result.signal} error=${result.error?.message ?? ''}\n`);
    } finally {
      closeSync(output);
    }
  }
}

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
  try {
    preserveStall();
  } catch (error) {
    console.error(`Stall evidence failed: ${error.message}`);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
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
