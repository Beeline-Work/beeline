import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const plugin = require('../../apps/mobile/plugins/withLatencyRigNativeProbe.js');
test('native probe cannot be installed into production or arbitrary host builds', () => {
  const previous = process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL;
  try {
    for (const url of ['https://server.usebeeline.app', 'http://localhost:8081', 'http://10.0.2.2.evil:8081', 'http://10.0.2.2']) {
      process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL = url;
      assert.throws(() => plugin({}), /disposable emulator host proxy/);
    }
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL;
    else process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL = previous;
  }
});
