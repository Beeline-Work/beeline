import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const productionSurfaces = [
  'apps/mobile/app.config.js',
  'apps/mobile/sources/sync/appConfig.ts',
  'apps/mobile/sources/buzz/runtime-config.ts',
  'apps/mobile/src-tauri/capabilities/default.json',
  '.github/actions/daemon-leg/action.yml',
  '.github/actions/server-leg/action.yml',
  '.github/workflows/unified-release.yml',
  'scripts/build-release-server-images.sh',
  'fly.beeline-server.toml',
];

test('production and release surfaces contain no legacy Buzz/Nostr route', async () => {
  const contents = await Promise.all(productionSurfaces.map((file) => readFile(file, 'utf8')));
  const joined = contents.join('\n');
  assert.doesNotMatch(joined, /buzz\.trustysquire\.ai|relay\.buzzrouter\.com|push\.buzzrouter\.com/);
  assert.doesNotMatch(joined, /buzz-router-relay-prod|legacy_mirror|BEELINE_DL_LEGACY_MIRROR/);
  assert.match(joined, /server\.usebeeline\.app/);
  assert.match(joined, /beeline-server/);
});
