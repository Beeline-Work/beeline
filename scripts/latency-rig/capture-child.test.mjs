
import { test as move17_test } from 'node:test';

import move17_assert from 'node:assert/strict';

import { spawn as move17_spawn } from 'node:child_process';

import { once as move17_once, EventEmitter as move17_EventEmitter } from 'node:events';

import { captureTeardown as move17_captureTeardown } from "./capture-child.mjs";
import { describe as movedDescribe17 } from 'node:test';
movedDescribe17("nightly-capture-child.test.mjs", () => {


move17_test('teardown after logcat already closed preserves the case error', { timeout: 2000 }, async () => {
  const child = move17_spawn(process.execPath, ['-e', '']);
  const stop = move17_captureTeardown(child);
  await move17_once(child, 'close');
  const original = new Error('Send-text requires the visible Room composer');
  await move17_assert.rejects(async () => {
    try { throw original; } finally { await stop(); }
  }, (error) => error === original);
  await stop();
});


move17_test('teardown stops a live child and can run twice', { timeout: 2000 }, async () => {
  const child = move17_spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const stop = move17_captureTeardown(child);
  await move17_once(child, 'spawn');
  await stop();
  await stop();
  move17_assert.equal(child.signalCode, 'SIGTERM');
});


move17_test('a child that never closes has a bounded teardown', async () => {
  const child = new move17_EventEmitter();
  const signals = [];
  const warnings = [];
  child.kill = (signal) => signals.push(signal);
  await move17_captureTeardown(child, { timeoutMs: 10, warn: (text) => warnings.push(text) })();
  move17_assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  move17_assert.equal(warnings.length, 1);
});
});
