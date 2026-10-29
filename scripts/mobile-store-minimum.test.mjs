import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setMobileStoreMinimum } from './mobile-store-minimum.mjs';

test('routine and nightly releases never write minimums', async () => {
  await setMobileStoreMinimum({ request: () => { throw new Error('Unexpected write'); } });
  const workflow = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /inputs\.mobile_store_minimum != ''/);
  assert.match(workflow, /MOBILE_STORE_MINIMUM: \$\{\{ inputs.mobile_store_minimum \}\}/);
});

test('only explicitly named platforms change, with a reason and authenticated request', async () => {
  const calls = [];
  const minimum = { minVersion: '0.2.24', reason: 'This version can no longer sign in.' };
  assert.deepEqual(await setMobileStoreMinimum({ policy: JSON.stringify({ android: minimum }), secret: 'test',
    request: async (url, init) => { calls.push({ url, init }); return new Response('{}'); } }), ['android']);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), { platform: 'android', ...minimum });
  assert.equal(calls[0].init.headers.authorization, 'Bearer test');
});

test('validates all platforms before writing and surfaces failed writes', async () => {
  let writes = 0;
  const request = async () => { writes++; return new Response('{}', { status: 503 }); };
  const android = { minVersion: '0.2.24', reason: 'Required update' };
  await assert.rejects(setMobileStoreMinimum({ policy: JSON.stringify({ android, ios: {} }), secret: 'test', request }));
  assert.equal(writes, 0);
  await assert.rejects(setMobileStoreMinimum({ policy: JSON.stringify({ android }), secret: 'test', request }), /503/);
});
