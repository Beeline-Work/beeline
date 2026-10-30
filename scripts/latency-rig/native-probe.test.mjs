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

import { readFileSync } from 'node:fs';
import { nativeArrivalMoment } from './room-arrivals.mjs';
test('four native tap cases retain their action identity through analysis input', () => {
  for (const name of ['react-message', 'open-corner', 'switch-tabs', 'open-composer']) {
    const result = nativeArrivalMoment('LATENCY_VISIBLE ' + JSON.stringify({
      probe: 'native-frame-commit-v1', case: name, startMs: 100, paintMs: 123 }), name);
    assert.deepEqual(result, { kind: 'tap', name, variant: 'warm', startMs: 100, paintMs: 123 });
  }
});
test('native completion contracts require result content and IME visibility', () => {
  const source = readFileSync(new URL('./android/LatencyRigProbe.java', import.meta.url), 'utf8');
  assert.match(source, /visibleRow\(room, p.needle, top\) && visibleReaction\(room, p.needle\)/);
  assert.match(source, /No pinned conversations yet\./);
  assert.match(source, /view instanceof EditText && view.hasFocus\(\)/);
  assert.match(source, /insets.isVisible\(WindowInsets.Type.ime\(\)\)/);
  assert.match(source, /registerFrameCommitCallback/);
  // Release minification renames Screen; a runtime class-name string never matches.
  assert.match(source, /parent instanceof com\.swmansion\.rnscreens\.Screen/);
  assert.doesNotMatch(source, /getClass\(\)\.getName\(\)/);
  // All tap timers share the existing fixture-only native ACTION_UP hook.
  assert.match(source, /"send-text".equals\(entry\) && isTap\(p.entry\)/);
});
