import assert from 'node:assert/strict';
import test from 'node:test';
import { hashMacHelperInputs, MAC_HELPER_INPUTS } from './mac-helper-inputs.mjs';

test('Mac payload provenance includes its source and toolchain, while release identity is regenerated', () => {
  for (const path of [
    'apps/body/', 'packages/nostr/', 'packages/api-contract/', 'packages/buzz-client/',
    'apps/gate/', 'package-lock.json', 'tsconfig.base.json',
    'scripts/build-beeline-bundle.mjs', 'scripts/beeline-archive.mjs',
    '.github/workflows/unified-release.yml',
  ]) assert.ok(MAC_HELPER_INPUTS.includes(path), path);
  const files = [['apps/body/src/cli.ts', Buffer.from('same payload')]];
  const toolchain = { platform: 'darwin-arm64', rustc: 'rustc 1', sdk: '15.5' };
  const original = hashMacHelperInputs(files, toolchain);
  assert.equal(original, hashMacHelperInputs(files, { ...toolchain }));
  assert.notEqual(original, hashMacHelperInputs([['apps/body/src/cli.ts', Buffer.from('changed')]], toolchain));
  assert.notEqual(original, hashMacHelperInputs(files, { ...toolchain, rustc: 'rustc 2' }));
  assert.notEqual(original, hashMacHelperInputs(files, { ...toolchain, sdk: '16.0' }));
});
