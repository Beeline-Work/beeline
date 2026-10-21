import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const name of ['BUZZY_PUSH_DATABASE_URL', 'BEELINE_PUSH_DATABASE_URL']) {
  test('cleanup requires DATABASE_URL even when ' + name + ' is set', () => {
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/cleanup-legacy-daemon-chat.ts', '--dry-run'],
      { env: { PATH: process.env.PATH, [name]: 'ignored-fixture' }, encoding: 'utf8' },
    );
    assert.equal(child.status, 1);
    assert.match(child.stderr, /set DATABASE_URL/);
    assert.equal(child.stdout, '');
  });
}
