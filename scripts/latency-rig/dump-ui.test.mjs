import test from 'node:test';
import assert from 'node:assert/strict';
import { dumpUi } from './dump-ui.mjs';

const xml = '<hierarchy rotation="0"><node text="fixture"/></hierarchy>';
const written = 'UI hierchary dumped to: /sdcard/latency-rig.xml';

test('reaction setup survives the finite WORKING counter left by send-text', async () => {
  let now = 7_000; // navigation and insertion after the last send
  const calls = [];
  const adb = (...args) => {
    calls.push(args);
    if (args[1] === 'uiautomator') {
      if (now + 10_000 < 91_000) {
        now += 10_000;
        return 'ERROR: could not get idle state.';
      }
      now = Math.max(now, 91_000);
      return written;
    }
    if (args[1] === 'cat') return xml;
    return '';
  };
  assert.equal(await dumpUi(adb, 'react-message setup', { wait: async ms => { now += ms; } }), xml);
  assert.equal(calls.filter(args => args[1] === 'uiautomator').length, 3);
  assert.equal(calls.filter(args => args[1] === 'rm').length, 3);
  // Failed dumps must never read an absent or stale file.
  assert.equal(calls.filter(args => args[1] === 'cat').length, 1);
});

test('an already idle screen adds no delay', async () => {
  const adb = (...args) => args[1] === 'uiautomator' ? written : args[1] === 'cat' ? xml : '';
  assert.equal(await dumpUi(adb, 'room list', { wait: async () => assert.fail('unnecessary wait') }), xml);
});

test('a screen that never idles fails with its action and sample instead of cat ENOENT', async () => {
  let attempts = 0;
  const waits = [];
  const adb = (...args) => {
    if (args[1] === 'cat') assert.fail('must not read an unsuccessful dump');
    if (args[1] === 'uiautomator') { attempts++; return 'ERROR: could not get idle state.'; }
    return '';
  };
  await assert.rejects(dumpUi(adb, 'react-message setup (sample 1/20)', {
    wait: async ms => waits.push(ms),
  }), /react-message setup \(sample 1\/20\) after three attempts: ERROR: could not get idle state/);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [35_000, 35_000]);
});

test('transport errors and incomplete files are retried, never returned as a hierarchy', async () => {
  let attempts = 0;
  const adb = (...args) => {
    if (args[1] === 'uiautomator') {
      if (++attempts === 1) throw new Error('adb transport failed');
      return written;
    }
    return args[1] === 'cat' ? (attempts === 2 ? '<hierarchy>' : xml) : '';
  };
  assert.equal(await dumpUi(adb, 'react-message setup', { wait: async () => {} }), xml);
  assert.equal(attempts, 3);
});
