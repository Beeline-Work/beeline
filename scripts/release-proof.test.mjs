import assert from 'node:assert/strict';
import test from 'node:test';
import { removeExistingAppInstall } from '../apps/mobile/scripts/release-proof.mjs';

function recordingIo({ installed, uninstallOk }) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    io: {
      shell: (device, command) => {
        calls.push(['shell', device, command]);
        return installed
          ? { ok: true, stdout: 'package:/data/app/~~x/app.usebeeline-base.apk\n', stderr: '' }
          : { ok: true, stdout: '', stderr: '' };
      },
      exec: (device, args) => {
        calls.push(['exec', device, args]);
        return uninstallOk
          ? { ok: true, stdout: 'Success\n', stderr: '' }
          : { ok: false, stdout: '', stderr: 'Failure [DELETE_FAILED_INTERNAL_ERROR]' };
      },
    },
  };
}

test('removeExistingAppInstall uninstalls a detected existing install and logs it', () => {
  const rec = recordingIo({ installed: true, uninstallOk: true });
  const originalLog = console.log;
  console.log = (...args) => rec.logs.push(args.join(' '));
  try {
    assert.equal(removeExistingAppInstall('emulator-5554', rec.io), true);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(rec.calls, [
    ['shell', 'emulator-5554', 'pm path app.usebeeline'],
    ['exec', 'emulator-5554', ['uninstall', 'app.usebeeline']],
  ]);
  assert.equal(rec.logs.length, 1);
  assert.match(rec.logs[0], /removed existing app\.usebeeline install/);
  assert.match(rec.logs[0], /stale higher versionCode/);
});

test('removeExistingAppInstall does nothing when no install is present', () => {
  const rec = recordingIo({ installed: false });
  assert.equal(removeExistingAppInstall('emulator-5554', rec.io), false);
  assert.deepEqual(rec.calls, [['shell', 'emulator-5554', 'pm path app.usebeeline']]);
  assert.equal(rec.logs.length, 0);
});

test('removeExistingAppInstall reports a failed uninstall but still reports false', () => {
  const rec = recordingIo({ installed: true, uninstallOk: false });
  const originalLog = console.log;
  console.log = (...args) => rec.logs.push(args.join(' '));
  try {
    assert.equal(removeExistingAppInstall('emulator-5554', rec.io), false);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(rec.calls.length, 2);
  assert.match(rec.logs[0], /could not remove the existing app\.usebeeline install/);
  assert.match(rec.logs[0], /DELETE_FAILED_INTERNAL_ERROR/);
});
