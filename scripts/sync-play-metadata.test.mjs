import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_OUT_DIR,
  DEFAULT_STORE_DIR,
  diffPlayMetadata,
  planPlayMetadata,
  readPngHeader,
  syncPlayMetadata,
} from './sync-play-metadata.mjs';

const SCRIPT = fileURLToPath(new URL('./sync-play-metadata.mjs', import.meta.url));

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// A minimal valid PNG: solid pixels, one IDAT, the given geometry and colour type.
function png({ width, height, colorType = 2, bitDepth = 8 }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const channels = colorType === 6 ? 4 : 3;
  const bytesPerPixel = channels * (bitDepth / 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * bytesPerPixel, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function makeStore(root, overrides = {}) {
  const store = path.join(root, 'store');
  write(store, 'listing/en-US/title.txt', overrides.title ?? 'Beeline\n');
  write(store, 'listing/en-US/short-description.txt', overrides.short ?? 'Short copy.\n');
  write(store, 'listing/en-US/full-description.txt', overrides.full ?? 'Full copy.\n\nSecond paragraph.\n');
  write(store, 'listing/en-US/release-notes.txt', overrides.notes ?? 'Notes.\n');
  write(store, 'assets/store-icon-512.png', overrides.icon ?? png({ width: 512, height: 512, colorType: 6 }));
  write(store, 'assets/feature-graphic-1024x500.png', overrides.feature ?? png({ width: 1024, height: 500 }));
  const shots = overrides.shots ?? { '01-room.png': png({ width: 540, height: 1045 }), '02-corner.png': png({ width: 540, height: 1045 }) };
  for (const [name, bytes] of Object.entries(shots)) write(store, `screenshots/${name}`, bytes);
  return store;
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'play-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('readPngHeader reads IHDR geometry, depth and colour type', () => {
  assert.deepEqual(readPngHeader(png({ width: 512, height: 512, colorType: 6 })), {
    width: 512,
    height: 512,
    bitDepth: 8,
    colorType: 6,
  });
  assert.throws(() => readPngHeader(Buffer.from('not a png at all, definitely not')), /not a PNG/);
});

test('sync writes the fastlane layout from the store package and removes stale files', (t) => {
  const root = tempRoot(t);
  const storeDir = makeStore(root);
  const outDir = path.join(root, 'metadata');
  write(outDir, 'en-US/images/phoneScreenshots/99-stale.png', png({ width: 320, height: 320 }));

  const { written, changed } = syncPlayMetadata({ storeDir, outDir });

  assert.deepEqual(written, [
    'en-US/title.txt',
    'en-US/short_description.txt',
    'en-US/full_description.txt',
    'en-US/changelogs/default.txt',
    'en-US/images/icon.png',
    'en-US/images/featureGraphic.png',
    'en-US/images/phoneScreenshots/01-room.png',
    'en-US/images/phoneScreenshots/02-corner.png',
  ]);
  assert.ok(changed.includes('en-US/images/phoneScreenshots/99-stale.png'));
  assert.equal(fs.existsSync(path.join(outDir, 'en-US/images/phoneScreenshots/99-stale.png')), false);
  assert.equal(fs.readFileSync(path.join(outDir, 'en-US/title.txt'), 'utf8'), 'Beeline\n');
  assert.equal(fs.readFileSync(path.join(outDir, 'en-US/full_description.txt'), 'utf8'), 'Full copy.\n\nSecond paragraph.\n');
  assert.ok(fs.readFileSync(path.join(outDir, 'en-US/images/icon.png')).equals(png({ width: 512, height: 512, colorType: 6 })));

  assert.deepEqual(diffPlayMetadata(planPlayMetadata({ storeDir }), { outDir }), []);
  assert.deepEqual(syncPlayMetadata({ storeDir, outDir }).changed, []);
});

test('text is trimmed to one trailing newline and held to the Play limits', (t) => {
  const root = tempRoot(t);
  const plan = planPlayMetadata({ storeDir: makeStore(root, { short: 'Trailing space and lines.   \n\n\n' }) });
  assert.equal(plan.get('en-US/short_description.txt').toString(), 'Trailing space and lines.\n');

  assert.throws(
    () => planPlayMetadata({ storeDir: makeStore(tempRoot(t), { short: `${'x'.repeat(81)}\n` }) }),
    /short description is 81 characters; Play allows 80/,
  );
  assert.throws(
    () => planPlayMetadata({ storeDir: makeStore(tempRoot(t), { notes: `${'n'.repeat(501)}\n` }) }),
    /release notes is 501 characters; Play allows 500/,
  );
  assert.throws(() => planPlayMetadata({ storeDir: makeStore(tempRoot(t), { title: '\n' }) }), /title.txt is empty/);
});

test('images are validated against the Play asset rules', (t) => {
  assert.throws(
    () => planPlayMetadata({ storeDir: makeStore(tempRoot(t), { icon: png({ width: 256, height: 256, colorType: 6 }) }) }),
    /store-icon-512.png is 256x256 8-bit RGBA; must be 512x512/,
  );
  assert.throws(
    () => planPlayMetadata({ storeDir: makeStore(tempRoot(t), { icon: png({ width: 512, height: 512, colorType: 2 }) }) }),
    /must be a 32-bit PNG with an alpha channel/,
  );
  assert.throws(
    () => planPlayMetadata({ storeDir: makeStore(tempRoot(t), { feature: png({ width: 1024, height: 500, colorType: 6 }) }) }),
    /featureGraphic|feature-graphic-1024x500.png is 1024x500 8-bit RGBA; must be a 24-bit PNG without an alpha channel/,
  );
  assert.throws(
    () => planPlayMetadata({ storeDir: makeStore(tempRoot(t), { icon: png({ width: 512, height: 512, colorType: 6, bitDepth: 16 }) }) }),
    /must be 8 bits per channel/,
  );
  assert.throws(
    () =>
      planPlayMetadata({
        storeDir: makeStore(tempRoot(t), { shots: { '01.png': png({ width: 100, height: 300 }), '02.png': png({ width: 320, height: 320 }) } }),
      }),
    /01.png is 100x300 8-bit RGB; each side must be between 320 and 3840 pixels; the long side may not exceed twice the short side/,
  );
  assert.throws(
    () => planPlayMetadata({ storeDir: makeStore(tempRoot(t), { shots: { '01.png': png({ width: 320, height: 320 }) } }) }),
    /holds 1 PNG screenshots; Play needs 2 to 8/,
  );
});

test('--check exits 1 with the stale paths and 0 once synced', (t) => {
  const root = tempRoot(t);
  const storeDir = makeStore(root);
  const outDir = path.join(root, 'metadata');
  const args = [SCRIPT, '--store', storeDir, '--out', outDir];

  const stale = spawnSync(process.execPath, [...args, '--check'], { encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Play metadata is stale; run node scripts\/sync-play-metadata.mjs/);
  assert.match(stale.stderr, /en-US\/images\/icon.png/);

  const sync = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, /8 files in .*; 8 changed/);

  const fresh = spawnSync(process.execPath, [...args, '--check'], { encoding: 'utf8' });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /Play metadata is up to date/);
});

test('the committed metadata dir is exactly what the store package derives to', () => {
  const plan = planPlayMetadata({ storeDir: DEFAULT_STORE_DIR });
  assert.deepEqual(diffPlayMetadata(plan, { outDir: DEFAULT_OUT_DIR }), []);
  assert.equal(plan.get('en-US/title.txt').toString(), 'Beeline\n');
  assert.equal(
    [...plan.keys()].filter((key) => key.includes('phoneScreenshots')).length,
    4,
    'four phone screenshots ride with the listing',
  );
});
