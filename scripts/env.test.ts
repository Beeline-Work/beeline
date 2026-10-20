import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readEnv } from './env.js';
test('cleanup database URL retains the old spelling and prefers Beeline', () => {
  assert.equal(readEnv({ BUZZY_PUSH_DATABASE_URL: 'old' }, 'PUSH_DATABASE_URL'), 'old');
  assert.equal(
    readEnv(
      { BUZZY_PUSH_DATABASE_URL: 'old', BEELINE_PUSH_DATABASE_URL: 'new' },
      'PUSH_DATABASE_URL',
    ),
    'new',
  );
  assert.equal(
    readEnv({ BUZZY_PUSH_DATABASE_URL: 'old', BEELINE_PUSH_DATABASE_URL: '' }, 'PUSH_DATABASE_URL'),
    '',
  );
});
