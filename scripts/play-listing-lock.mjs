#!/usr/bin/env node
// Compare the build edit with its own pre-upload listing, never with repo text.
// A changed listing stops the build before its automatic review submission.
// https://developers.google.com/android-publisher/api-ref/rest/v3/edits.images/list
import { readFileSync, writeFileSync } from 'node:fs';

const [mode, file] = process.argv.slice(2);
const { PACKAGE_NAME, PLAY_EDIT_ID, ACCESS_TOKEN, PLAY_DRY_RUN } = process.env;
if (!['snapshot', 'verify'].includes(mode) || !file || !PACKAGE_NAME || !PLAY_EDIT_ID)
  throw new Error('Listing lock requires snapshot|verify, a baseline path, PACKAGE_NAME and PLAY_EDIT_ID');
const base = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
  encodeURIComponent(PACKAGE_NAME) + '/edits/' + encodeURIComponent(PLAY_EDIT_ID);
const imageTypes = ['phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots',
  'tvScreenshots', 'wearScreenshots', 'icon', 'featureGraphic', 'tvBanner'];

async function get(suffix) {
  if (PLAY_DRY_RUN === '1') return suffix === '' ? { id: PLAY_EDIT_ID } : {};
  if (!ACCESS_TOKEN) throw new Error('Listing lock requires ACCESS_TOKEN');
  const response = await fetch(base + suffix, {
    headers: { Authorization: 'Bearer ' + ACCESS_TOKEN }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('Listing lock could not read ' + (suffix || 'edit') + ': HTTP ' + response.status);
  const body = await response.text();
  return body.trim() ? JSON.parse(body) : {};
}

try {
  const edit = await get('');
  if (edit.id !== PLAY_EDIT_ID) throw new Error('Listing lock could not validate the Play edit');
  const response = await get('/listings');
  const listings = response.listings ?? [];
  if (!Array.isArray(listings)) throw new Error('Invalid Play listings response');
  const items = {};
  for (const listing of listings) {
    if (!listing || typeof listing.language !== 'string') throw new Error('Invalid Play listing language');
    const language = listing.language;
    items[language + '/locale'] = true;
    for (const field of ['title', 'shortDescription', 'fullDescription', 'video'])
      items[language + '/' + field] = listing[field] ?? '';
    for (const type of imageTypes) {
      const response = await get('/listings/' + encodeURIComponent(language) + '/' + type);
      const images = response.images ?? [];
      if (!Array.isArray(images)) throw new Error('Invalid Play images: ' + language + '/' + type);
      items[language + '/images/' + type] = images.map(image => {
        if (!image || typeof image.id !== 'string' || (!image.sha256 && !image.sha1))
          throw new Error('Missing Play image identity/hash: ' + language + '/' + type);
        return { id: image.id, sha256: image.sha256 ?? '', sha1: image.sha1 ?? '' };
      });
    }
  }
  if (mode === 'snapshot') {
    writeFileSync(file, JSON.stringify({ editId: PLAY_EDIT_ID, items }), { mode: 0o600 });
    console.log('Play listing lock: recorded pre-upload text/images');
  } else {
    const before = JSON.parse(readFileSync(file, 'utf8'));
    if (before.editId !== PLAY_EDIT_ID || !before.items || typeof before.items !== 'object')
      throw new Error('Listing lock baseline does not belong to this edit');
    const changed = [...new Set([...Object.keys(before.items), ...Object.keys(items)])]
      .filter(key => JSON.stringify(before.items[key]) !== JSON.stringify(items[key])).sort();
    if (changed.length)
      throw new Error('Listing lock stopped before commit; changed items: ' + changed.join(', '));
    console.log('Play listing lock passed: build edit has no text/image changes');
  }
} catch (error) {
  console.error('::error::' + error.message);
  process.exitCode = 1;
}
