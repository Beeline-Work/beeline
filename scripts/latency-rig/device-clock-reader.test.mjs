import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDeviceClockReader } from './device-clock-reader.mjs';

function fixture(timeoutMs = 1000) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const reader = createDeviceClockReader('emulator-test', { timeoutMs, spawnShell: (cmd, args) => {
    assert.equal(cmd, 'adb');
    assert.deepEqual(args, ['-s', 'emulator-test', 'shell', '-T']);
    return child;
  } });
  return { reader, child };
}

test('reads one complete line per command across split chunks in the same shell', async () => {
  const { reader, child } = fixture();
  const commands = [];
  child.stdin.on('data', (chunk) => commands.push(String(chunk)));
  try {
    const first = reader.read();
    child.stdout.write('1700000');
    child.stdout.write('000001\r\n');
    assert.equal(await first, 1700000000001);
    const second = reader.read();
    child.stdout.write('1700000000002\n');
    assert.equal(await second, 1700000000002);
    assert.deepEqual(commands, ['date +%s%3N\n', 'date +%s%3N\n']);
  } finally { reader.close(); }
});

for (const kind of ['timeout', 'exit', 'invalid']) {
  test(`fails permanently on ${kind} without reusing late output`, async () => {
    const { reader, child } = fixture(10);
    const reading = reader.read();
    if (kind === 'exit') child.emit('close', 1, null);
    if (kind === 'invalid') child.stdout.write('not a date\n');
    const pattern = /timed out|exited|Invalid device/;
    await assert.rejects(reading, pattern);
    child.stdout.write('1700000000002\n');
    await assert.rejects(reader.read(), pattern);
    reader.close();
  });
}
