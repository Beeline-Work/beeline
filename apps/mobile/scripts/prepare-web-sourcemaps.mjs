import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadSentrySourcemaps } from './upload-sentry-sourcemaps.mjs';

/** Finish private symbol upload before the export may reach a public host. */
export function prepareWebSourcemaps(directory, release, options = {}) {
  const bundles = join(directory, '_expo/static/js/web');
  const files = readdirSync(bundles, { recursive: true }).filter(file => file.endsWith('.js'));
  if (!files.length) throw new Error('Web export contains no JavaScript bundles');
  for (const file of files) {
    const bundle = join(bundles, file);
    const map = JSON.parse(readFileSync(`${bundle}.map`, 'utf8'));
    const debugId = map.debug_id || map.debugId;
    if (!debugId || !readFileSync(bundle, 'utf8').includes(debugId)) {
      throw new Error(`Web bundle and source map debug IDs do not match: ${file}`);
    }
  }
  uploadSentrySourcemaps(directory, release, { ...options, required: true });
  console.log(`Sentry web source maps processed for release ${release}`);
  for (const file of readdirSync(directory, { recursive: true })) {
    if (file.endsWith('.map')) rmSync(join(directory, file));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareWebSourcemaps(process.argv[2], process.argv[3]);
}
