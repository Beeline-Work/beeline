import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkNpmPackageVisibility,
  NPM_VIEW_TIMEOUT_MS,
  NPM_VISIBILITY_TIMEOUT_MS,
  npmVisibilityTimeoutMs,
  lookupPublicNpmPackage,
  waitForNpmPackageVisibility,
} from './npm-package-visibility.mjs';

const PACKAGE = 'usebeeline';
const VERSION = '0.0.71';

test('a stuck npm process is forcibly terminated at its command deadline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'npm-visibility-'));
  const previousPath = process.env.PATH;
  try {
    const npm = join(directory, 'npm');
    writeFileSync(npm, `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`);
    chmodSync(npm, 0o755);
    process.env.PATH = directory;
    const result = lookupPublicNpmPackage({ packageName: PACKAGE, version: VERSION, timeoutMs: 200 });
    assert.equal(result.error?.code, 'ETIMEDOUT');
    assert.equal(result.signal, 'SIGKILL');
  } finally {
    process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

function npmResult({ status, stdout = '', stderr = '' }) {
  return { status, stdout, stderr };
}

test('npm visibility and command deadlines stay bounded', () => {
  assert.equal(NPM_VISIBILITY_TIMEOUT_MS, 300_000);
  assert.equal(NPM_VIEW_TIMEOUT_MS, 20_000);
});

test('visibility deadline is configurable in milliseconds and rejects invalid overrides', () => {
  assert.equal(npmVisibilityTimeoutMs({}), 300_000);
  assert.equal(npmVisibilityTimeoutMs({ NPM_VISIBILITY_TIMEOUT_MS: '420000' }), 420_000);
  for (const value of ['', ' ', '0', '-1', '1.5', 'no', 'Infinity']) {
    assert.throws(
      () => npmVisibilityTimeoutMs({ NPM_VISIBILITY_TIMEOUT_MS: value }),
      /positive integer/,
    );
  }
});

test('Reproduction npm-delayed-visibility: a version visible after two minutes passes within the default deadline', async () => {
  let now = 0;
  const result = await waitForNpmPackageVisibility({
    packageName: PACKAGE,
    version: VERSION,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    lookup: async ({ timeoutMs }) => {
      assert.ok(timeoutMs <= 20_000);
      return now >= 120_000
        ? npmResult({ status: 0, stdout: VERSION })
        : npmResult({ status: 1, stderr: 'npm error code E404' });
    },
  });
  assert.ok(result.elapsedMs >= 120_000);
  assert.ok(result.elapsedMs < 300_000);
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
    retryIntervalMs: 5_000,
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

  assert.deepEqual(result, { attempts: 3, elapsedMs: 10_000 });
  assert.deepEqual(waits, [5_000, 5_000]);
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(({ packageName, version }) => packageName === PACKAGE && version === VERSION),
  );
  assert.ok(calls.every(({ timeoutMs }) => timeoutMs <= 20_000));
});

test('a permanent npm 404 fails at the visibility deadline', async () => {
  let now = 0;
  const commandTimeouts = [];
  const logs = [];

  await assert.rejects(
    waitForNpmPackageVisibility({
      packageName: PACKAGE,
      version: VERSION,
      timeoutMs: 12_000,
      log: (message) => logs.push(message),
      retryIntervalMs: 5_000,
      lookup: async ({ timeoutMs: commandTimeoutMs }) => {
        commandTimeouts.push(commandTimeoutMs);
        return npmResult({ status: 1, stderr: 'npm error code E404' });
      },
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    }),
    /was not visible after 12000ms \(3 attempts\) on https:\/\/registry.npmjs.org; verify npm publication succeeded/,
  );

  assert.equal(now, 12_000);
  assert.match(logs[0], /Waiting up to 12000ms/);
  assert.match(logs[1], /attempt 1.*retrying in 5000ms/);
  assert.match(logs.at(-1), /attempt 3.*retrying in 2000ms/);
  assert.deepEqual(commandTimeouts, [12_000, 7_000, 2_000]);
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


test('npm-delayed-visibility: warn mode exits zero after E404 deadline and reports non-404 errors', async () => {
  for (const stderr of ['npm error code E404', 'npm error code E401']) {
    let clock = 0;
    const logs = [];
    assert.equal(await checkNpmPackageVisibility({
      packageName: PACKAGE, version: VERSION, timeoutMs: 10,
      lookup: async () => ({ status: 1, stderr }),
      now: () => clock, sleep: async ms => { clock += ms; }, log: () => {},
    }, { warn: true, log: line => logs.push(line) }), 0);
    assert.match(logs[0], /^::warning::/);
    assert.match(logs[0], stderr.includes('E404') ? /not visible after 10ms/ : /E401/);
  }
});


test('warn CLI returns exit zero with a GitHub warning for a registry timeout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'npm-warning-cli-'));
  try {
    const npm = join(directory, 'npm');
    writeFileSync(npm, `#!${process.execPath}\nconsole.error('npm error code E404'); process.exit(1);\n`);
    chmodSync(npm, 0o755);
    const result = spawnSync(process.execPath, ['scripts/npm-package-visibility.mjs', PACKAGE, VERSION, '--warn'], {
      encoding: 'utf8', env: { ...process.env, PATH: directory, NPM_VISIBILITY_TIMEOUT_MS: '1000' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::.*not visible after 1000ms/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
