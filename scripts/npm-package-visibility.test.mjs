import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NPM_VIEW_TIMEOUT_MS,
  NPM_VISIBILITY_TIMEOUT_MS,
  waitForNpmPackageVisibility,
} from './npm-package-visibility.mjs';

const PACKAGE = 'usebeeline';
const VERSION = '0.0.71';

function npmResult({ status, stdout = '', stderr = '' }) {
  return { status, stdout, stderr };
}

test('npm visibility and command deadlines stay bounded', () => {
  assert.equal(NPM_VISIBILITY_TIMEOUT_MS, 300_000);
  assert.equal(NPM_VIEW_TIMEOUT_MS, 20_000);
});

test('temporary npm 404s are retried until the exact version is visible', async () => {
  let now = 0;
  const calls = [];
  const waits = [];
  const results = [
    npmResult({ status: 1, stderr: 'npm error code E404\nnpm error 404 Not Found' }),
    npmResult({ status: 1, stderr: 'npm error code E404\nnpm error 404 Not Found' }),
    npmResult({ status: 0, stdout: `${VERSION}\n` }),
  ];

  const result = await waitForNpmPackageVisibility({
    packageName: PACKAGE,
    version: VERSION,
    timeoutMs: 300_000,
    initialBackoffMs: 5_000,
    lookup: async (request) => {
      calls.push(request);
      return results.shift();
    },
    now: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  });

  assert.deepEqual(result, { attempts: 3, elapsedMs: 15_000 });
  assert.deepEqual(waits, [5_000, 10_000]);
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(({ packageName, version }) => packageName === PACKAGE && version === VERSION),
  );
  assert.ok(calls.every(({ timeoutMs }) => timeoutMs <= 20_000));
});

test('a permanent npm 404 fails at the visibility deadline', async () => {
  let now = 0;
  const commandTimeouts = [];

  await assert.rejects(
    waitForNpmPackageVisibility({
      packageName: PACKAGE,
      version: VERSION,
      timeoutMs: 12_000,
      initialBackoffMs: 5_000,
      lookup: async ({ timeoutMs: commandTimeoutMs }) => {
        commandTimeouts.push(commandTimeoutMs);
        return npmResult({ status: 1, stderr: 'npm error code E404' });
      },
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    }),
    /was not visible after 12000ms/,
  );

  assert.equal(now, 12_000);
  assert.deepEqual(commandTimeouts, [12_000, 7_000]);
});

test('an already visible npm version passes immediately', async () => {
  let slept = false;
  const result = await waitForNpmPackageVisibility({
    packageName: PACKAGE,
    version: VERSION,
    lookup: async () => npmResult({ status: 0, stdout: `${VERSION}\n` }),
    now: () => 0,
    sleep: async () => {
      slept = true;
    },
  });

  assert.deepEqual(result, { attempts: 1, elapsedMs: 0 });
  assert.equal(slept, false);
});

test('a terminal npm error fails immediately without retrying', async () => {
  let calls = 0;
  let slept = false;

  await assert.rejects(
    waitForNpmPackageVisibility({
      packageName: PACKAGE,
      version: VERSION,
      lookup: async () => {
        calls += 1;
        return npmResult({
          status: 1,
          stderr: 'npm error code E401\nnpm error Unable to authenticate',
        });
      },
      sleep: async () => {
        slept = true;
      },
    }),
    /npm view failed:.*E401/s,
  );

  assert.equal(calls, 1);
  assert.equal(slept, false);
});

test('malformed npm metadata fails immediately without retrying', async () => {
  let slept = false;

  await assert.rejects(
    waitForNpmPackageVisibility({
      packageName: PACKAGE,
      version: VERSION,
      lookup: async () => npmResult({ status: 0, stdout: 'not-the-requested-version\n' }),
      sleep: async () => {
        slept = true;
      },
    }),
    /unexpected version metadata/,
  );

  assert.equal(slept, false);
});
