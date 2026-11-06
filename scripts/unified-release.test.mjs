import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RELEASE_COMPONENTS,
  changedPathsFromPublishedInputs,
  initializeRelease,
  planOutputs,
  selectReleaseComponents,
  selectReleaseComponentsFromPublishedInputs,
} from './unified-release.mjs';

const previousSha = 'a'.repeat(40);
const releaseSha = 'b'.repeat(40);
const componentPaths = (paths = []) => Object.fromEntries(RELEASE_COMPONENTS.map(component => [component, paths]));
const publishedRelease = () => {
  const previous = initializeRelease({ version: 'v0.1.162', sourceSha: previousSha });
  previous.state = 'delivered';
  for (const entry of Object.values(previous.components)) entry.state = 'checked';
  return previous;
};

for (const path of [
  'apps/mobile/sources/components/buzz/room-list-row.ts',
  'apps/mobile/assets/icon.png',
  'packages/api-contract/src/index.ts',
  'packages/buzz-client/src/index.ts',
  'packages/nostr/src/index.ts',
  'packages/net/src/route-codecs.ts',
  'apps/mobile/index.ts',
  'apps/mobile/metro.config.js',
  'apps/mobile/babel.config.js',
  'apps/mobile/public/canvaskit.wasm',
  'apps/mobile/patches/@expo+vector-icons+15.1.1.patch',
  'apps/mobile/scripts/patch-livekit-abort.cjs',
  'apps/mobile/scripts/patch-livekit-owned.cjs',
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'apps/mobile/app.config.js',
  'apps/mobile/package.json',
  'apps/mobile/package-lock.json',
  'apps/mobile/src-tauri/src/lib.rs',
  'apps/mobile/src-tauri/Cargo.lock',
  'apps/mobile/src-tauri/tauri.conf.json',
]) {
  test(`desktop rebuilds immediately for its bundled input: ${path}`, () => {
    assert.ok(selectReleaseComponents([path]).includes('desktop'));
    const previous = publishedRelease();
    const selectedComponents = selectReleaseComponentsFromPublishedInputs(componentPaths([path]));
    const state = initializeRelease({ version: 'v0.1.163', sourceSha: releaseSha, previous, selectedComponents });
    assert.match(planOutputs(state, previous), /^run_desktop=true$/m);
    assert.equal(state.components.desktop.sourceSha, releaseSha);
    assert.notEqual(state.components.desktop.desktopVersion, previous.components.desktop.desktopVersion);
  });
}

for (const paths of [[], ['apps/server/src/index.ts'], ['web/index.html']]) {
  test(`desktop carries its published build when bundled inputs are unchanged: ${JSON.stringify(paths)}`, () => {
    const previous = publishedRelease();
    const selectedComponents = selectReleaseComponentsFromPublishedInputs(componentPaths(paths));
    assert.equal(selectedComponents.includes('desktop'), false);
    const state = initializeRelease({ version: 'v0.1.163', sourceSha: releaseSha, previous, selectedComponents });
    assert.match(planOutputs(state, previous), /^run_desktop=false$/m);
    assert.equal(state.components.desktop.sourceSha, previous.components.desktop.sourceSha);
    assert.equal(state.components.desktop.artifactRef, previous.components.desktop.artifactRef);
    assert.equal(state.components.desktop.desktopVersion, previous.components.desktop.desktopVersion);
    if (paths[0]?.startsWith('apps/server/')) assert.deepEqual(selectedComponents, ['server']);
  });
}

test('desktop compares against its own published source even when the other components are current', () => {
  const previous = publishedRelease();
  previous.sourceSha = releaseSha;
  for (const [component, entry] of Object.entries(previous.components)) {
    if (component !== 'desktop') entry.sourceSha = releaseSha;
  }
  const paths = changedPathsFromPublishedInputs(previous, releaseSha, {
    gitDiff: publishedSha => publishedSha === previousSha ? 'apps/mobile/sources/app/index.tsx\n' : '',
  });
  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(paths), ['desktop']);
});

test('explicit recovery selection still controls which components rebuild', () => {
  const paths = componentPaths(['apps/mobile/sources/app/index.tsx']);
  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(paths, { selection: 'server' }), ['server']);
  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(componentPaths(), { selection: 'desktop' }), ['desktop']);
});
