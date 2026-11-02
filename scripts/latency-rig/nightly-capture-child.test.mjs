import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { captureTeardown } from './capture-child.mjs';

test('teardown after logcat already closed preserves the case error', { timeout: 2000 }, async () => {
  const child = spawn(process.execPath, ['-e', '']);
  const stop = captureTeardown(child);
  await once(child, 'close');
  const original = new Error('Send-text requires the visible Room composer');
  await assert.rejects(async () => {
    try { throw original; } finally { await stop(); }
  }, (error) => error === original);
  await stop();
});

test('teardown stops a live child and can run twice', { timeout: 2000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const stop = captureTeardown(child);
  await once(child, 'spawn');
  await stop();
  await stop();
  assert.equal(child.signalCode, 'SIGTERM');
});

test('a child that never closes has a bounded teardown', async () => {
  const child = new EventEmitter();
  const signals = [];
  const warnings = [];
  child.kill = (signal) => signals.push(signal);
  await captureTeardown(child, { timeoutMs: 10, warn: (text) => warnings.push(text) })();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(warnings.length, 1);
});
