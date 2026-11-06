import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkNoEmulatorStart, emulatorStarts } from './check-no-emulator-start.mjs';

test('helper source contains no emulator launcher', () => {
  assert.deepEqual(checkNoEmulatorStart(new URL('..', import.meta.url).pathname), []);
});
test('guard rejects direct, aliased, constant and environment-driven launches', () => {
  for (const source of [
    `spawn('emulator', ['-avd', name]);`,
    `execFile('/sdk/emulator/emulator', args);`,
    `const launch = promisify(execFile); launch('/sdk/emulator/emulator', args);`,
    `const launch = childProcess.spawn; launch('emulator', args);`,
    'exec(`emulator -avd ${name}`);',
    `import { spawn as launch } from 'node:child_process'; launch('qemu-system-x86_64', args);`,
    `const binary = env.BEELINE_ANDROID_EMULATOR_BINARY; const args = ['-avd', name]; spawn(binary, args);`,
    `const executable = '/sdk/emulator/emulator'; const command = executable; childProcess.spawn(command, args);`,
  ]) assert.equal(emulatorStarts('apps/body/src/boot.ts', source).length, 1, source);
});
test('guard permits ordinary host command execution and emulator reporting', () => {
  assert.deepEqual(emulatorStarts('apps/body/src/host.ts', `
    const message = 'host emulator unavailable';
    execFile('git', ['status']);
    spawn(argv[0], argv.slice(1));
  `), []);
});

test('guard rejects shell emulator launchers', () => {
  assert.equal(emulatorStarts('apps/body/scripts/boot.sh', 'setsid /sdk/emulator/emulator -avd pixel &').length, 1);
  assert.deepEqual(emulatorStarts('apps/body/scripts/report.sh', 'echo "Host emulator unavailable"'), []);
});
