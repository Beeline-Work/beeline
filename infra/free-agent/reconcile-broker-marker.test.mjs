import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileBrokerMarker } from './reconcile-broker-marker.mjs';

test('image replacement reconciles the directory anchor and preserves the account binding', () => {
  const home = mkdtempSync(join(tmpdir(), 'broker-image-'));
  try {
    reconcileBrokerMarker(home);
    const dir = join(home, '.trusty-squire');
    mkdirSync(join(dir, 'chrome-profile'), { recursive: true });
    const path = join(dir, '.trusty-squire-broker-unit.json');
    writeFileSync(path, JSON.stringify({ version: 1, socket: join(dir, 'broker.sock'),
      profile: { dev: 0, ino: 218, name: 'chrome-profile' }, accountBinding: 'existing-account' }));
    reconcileBrokerMarker(home);
    const marker = JSON.parse(readFileSync(path, 'utf8'));
    const parent = statSync(dir);
    assert.deepEqual(marker.profile, { dev: parent.dev, ino: parent.ino, name: 'chrome-profile' });
    assert.equal(marker.accountBinding, 'existing-account');
    const once = readFileSync(path, 'utf8');
    reconcileBrokerMarker(home);
    assert.equal(readFileSync(path, 'utf8'), once);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    marker.socket = '/another/broker.sock';
    writeFileSync(path, JSON.stringify(marker));
    assert.throws(() => reconcileBrokerMarker(home), /Unexpected hosted broker marker/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
