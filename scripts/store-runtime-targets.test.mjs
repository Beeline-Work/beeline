import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playLiveBuilds, resolveStoreBuilds, storeRuntimeTargets } from '../apps/mobile/scripts/store-runtime-targets.mjs';
import { readStores } from './read-store-runtimes.mjs';
import { publicationSeed } from './seed-store-runtime-history.mjs';
import { readFileSync } from 'node:fs';

test('only published production artifacts admit Play runtimes, including halted/partial releases', () => {
  const release = (state, versionCode) => ({ track: 'production', releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`, activeArtifacts: [{ versionCode }] });
  assert.deepEqual(playLiveBuilds({ releases: [release('PUBLISHED', 138), release('IN_REVIEW', 142), release('APPROVED_NOT_PUBLISHED', 141), release('NOT_SENT_FOR_REVIEW', 140)] }), ['138']);
  assert.throws(() => resolveStoreBuilds('android', ['138'], []), /Cannot prove/);
  assert.deepEqual(resolveStoreBuilds('android', ['138'], [{ platform: 'android', buildNumber: '138', runtimeVersion: '40' }]), [{ platform: 'android', buildNumber: '138', runtimeVersion: '40' }]);
});

test('unreadable store preserves exactly the prior targets and never promotes OTA history to store evidence', () => {
  const previousTargets = [{ platform: 'android', runtimeVersion: '41' }, { platform: 'android', runtimeVersion: '40' }, { platform: 'ios', runtimeVersion: '35' }];
  const targets = storeRuntimeTargets({ pins: { android: '43', ios: '36' }, previousTargets, stores: { ios: { status: 'readable', live: [] } } });
  assert.deepEqual(targets, previousTargets.slice(0, 2));
});

test('ASC includes every distributed version and ignores review, TestFlight and superseded versions', async () => {
  const version = (state, id) => ({ attributes: { appVersionState: state }, relationships: { build: { data: { id } } } });
  const stores = await readStores({ builds: [{ platform: 'ios', buildNumber: '88', runtimeVersion: '34' }],
    env: {}, appleApi: async () => ({ data: [version('READY_FOR_DISTRIBUTION', 'b88'), version('WAITING_FOR_REVIEW', 'b99')], included: [{ type: 'builds', id: 'b88', attributes: { version: '88' } }] }) });
  assert.equal(stores.android.status, 'unavailable');
  assert.deepEqual(stores.ios.live.map(({ observedLiveAt, ...target }) => target), [{ platform: 'ios', runtimeVersion: '34', buildNumber: '88' }]);
  assert.equal(stores.ios.latestRuntimeVersion, '34');
});

test('one-time store history seed includes published 38/39 and excludes the undated upload', () => {
  const builds = JSON.parse(readFileSync(new URL('../apps/mobile/store/native-runtime-builds.json', import.meta.url), 'utf8'));
  assert.deepEqual(publicationSeed(builds).map(t => t.runtimeVersion), ['39', '38']);
  assert(publicationSeed(builds).every(t => t.publishedAt));
});

test('iOS uses its own live history, skips unshipped pins, and keeps only its previous set on failure', () => {
  const targets = storeRuntimeTargets({ pins: { android: '43', ios: '39' }, stores: {
    android: { status: 'readable', live: [{ platform: 'android', runtimeVersion: '40' }] },
    ios: { status: 'readable', live: [{ platform: 'ios', runtimeVersion: '36' }] },
  }, previouslyLive: [
    { platform: 'android', runtimeVersion: '39' },
    { platform: 'ios', runtimeVersion: '34' }, { platform: 'ios', runtimeVersion: '31' },
  ] });
  assert.deepEqual(targets.filter(t => t.platform === 'ios').map(t => t.runtimeVersion), ['36', '34', '31']);
  const fallback = storeRuntimeTargets({ pins: { android: '44', ios: '40' }, stores: {}, previousTargets: targets });
  assert.deepEqual(fallback, targets);
});

test('missing ASC binary identity fails closed instead of silently omitting live users', async () => {
  const stores = await readStores({ builds: [], env: {}, appleApi: async () => ({ data: [{ attributes: { appVersionState: 'READY_FOR_DISTRIBUTION' } }] }) });
  assert.equal(stores.ios.status, 'unavailable');
});

test('known current ASC build with an unresolved historical build remains unverified', async () => {
  const version = (state, id) => ({ attributes: { appVersionState: state }, relationships: { build: { data: { id } } } });
  const stores = await readStores({ builds: [{ platform: 'ios', buildNumber: '98', runtimeVersion: '36' }], env: {},
    appleApi: async () => ({ data: [version('READY_FOR_DISTRIBUTION', 'b98'), version('REPLACED_WITH_NEW_VERSION', 'b97')],
      included: [{ type: 'builds', id: 'b98', attributes: { version: '98' } }, { type: 'builds', id: 'b97', attributes: { version: '97' } }] }) });
  assert.equal(stores.ios.status, 'unavailable');
  assert.match(stores.ios.reason, /Cannot prove runtime of ios store build 97/);
  assert.deepEqual(stores.ios.buildNumbers, ['98']);
  assert.deepEqual(stores.ios.historicalBuildNumbers, ['97']);
  assert.equal(stores.ios.live, undefined);
  const previousTargets = ['34', '35', '36'].map(runtimeVersion => ({ platform: 'ios', runtimeVersion }));
  assert.deepEqual(storeRuntimeTargets({ pins: { android: '43', ios: '36' }, stores, previousTargets }), previousTargets);
});

test('verified local IPA identities resolve ASC current and prior published runtimes', async () => {
  const builds = JSON.parse(readFileSync(new URL('../apps/mobile/store/native-runtime-builds.json', import.meta.url), 'utf8'));
  const version = (state, id) => ({ attributes: { appVersionState: state }, relationships: { build: { data: { id } } } });
  const stores = await readStores({ builds, env: {}, appleApi: async () => ({
    data: [version('READY_FOR_DISTRIBUTION', 'b98'), version('REPLACED_WITH_NEW_VERSION', 'b97'), version('REPLACED_WITH_NEW_VERSION', 'b81')],
    included: ['98', '97', '81'].map(version => ({ type: 'builds', id: `b${version}`, attributes: { version } })),
  }) });
  assert.equal(stores.ios.status, 'readable');
  assert.deepEqual(stores.ios.live.map(t => t.runtimeVersion), ['36']);
  assert.deepEqual(storeRuntimeTargets({ pins: { android: '43', ios: '36' }, stores })
    .filter(t => t.platform === 'ios').map(t => t.runtimeVersion), ['36', '35', '31']);
});
