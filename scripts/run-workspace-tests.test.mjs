import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedWorkspaceTests } from './run-workspace-tests.mjs';

test('missing, foreign-head, malformed and unknown-file selections fall back to the full suite', () => {
  const current = { version: 1, sha: 'head', mode: 'subset', groups: { mobile: ['apps/mobile/sources/x.test.ts'] } };
  const choose = selection => selectedWorkspaceTests({ selection, sha: 'head', group: 'mobile', discovered: ['apps/mobile/sources/x.test.ts'] });
  assert.deepEqual(choose(current), ['apps/mobile/sources/x.test.ts']);
  for (const selection of [undefined, { ...current, version: 0 }, { ...current, sha: 'older' },
    { ...current, mode: 'unexpected' }, { ...current, groups: {} },
    { ...current, groups: { mobile: ['apps/mobile/sources/missing.test.ts'] } },
    { ...current, groups: { mobile: ['apps/mobile/sources/x.test.ts', 'apps/mobile/sources/x.test.ts'] } }]) assert.equal(choose(selection), null);
  assert.deepEqual(choose({ ...current, groups: { mobile: [] } }), []);
});
