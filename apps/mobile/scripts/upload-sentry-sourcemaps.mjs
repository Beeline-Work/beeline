import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

/** Upload only the artifacts produced by this export. Diagnostics never gate OTA. */
export function uploadSentrySourcemaps(directory, release, { run = spawnSync, warn = console.warn } = {}) {
  try {
    if (!/^[a-f0-9]{40}$/.test(release ?? '')) throw new Error('full release SHA required');
    if (!process.env.SENTRY_AUTH_TOKEN) throw new Error('SENTRY_AUTH_TOKEN is unavailable');
    const files = readdirSync(directory, { recursive: true }).map(file => join(directory, file));
    const maps = files.filter(file => file.endsWith('.map'));
    if (!maps.length) throw new Error('export contains no source maps');
    const artifacts = maps.flatMap(file => {
      const map = JSON.parse(readFileSync(file, 'utf8'));
      if (!(map.debug_id || map.debugId) || !map.sources?.length || !map.mappings) {
        throw new Error('export map is missing debug ID or mappings');
      }
      const bundle = file.slice(0, -4);
      if (!files.includes(bundle)) throw new Error('export map has no matching bundle');
      // Expo writes camelCase; sentry-cli's artifact association uses debug_id.
      if (!map.debug_id) {
        map.debug_id = map.debugId;
        writeFileSync(file, JSON.stringify(map));
      }
      return [bundle, file];
    });
    const result = run(process.execPath, [require.resolve('@sentry/cli/bin/sentry-cli'),
      'sourcemaps', 'upload', '--release', release, '--debug-id-reference', '--strict', ...artifacts], {
      env: { ...process.env, SENTRY_ORG: 'beeline-bt', SENTRY_PROJECT: 'beeline-mobile' },
      stdio: 'inherit', timeout: 120_000,
    });
    if (result.status !== 0) throw new Error('sentry-cli upload failed');
    return true;
  } catch (error) {
    warn(`::warning::Mobile Sentry source maps were not uploaded: ${error.message}`);
    return false;
  }
}
