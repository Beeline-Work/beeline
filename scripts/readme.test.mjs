import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL,
  MIRROR,
  readmeImageUrls,
  readmeTargets,
  relativeTargets,
  syncReadme,
} from './sync-readme.mjs';
import { badgeTitle, badgeVerdict, isTransientStatus, verifyBadges } from './verify-readme-badges.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonical = fs.readFileSync(CANONICAL, 'utf8');

test('the root README is a byte-for-byte copy of the published one', () => {
  assert.equal(
    fs.readFileSync(MIRROR, 'utf8'),
    canonical,
    'run `npm run readme:sync` — README.md is generated from packages/usebeeline/README.md',
  );
  assert.deepEqual(syncReadme({ check: true }), []);
});

test('the published package still ships the canonical README', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO, 'packages', 'usebeeline', 'package.json'), 'utf8'),
  );
  assert.ok(manifest.files.includes('README.md'));
  assert.equal(manifest.homepage, 'https://usebeeline.app');
  assert.ok(manifest.keywords.length > 0);
});

test('no link is relative, because the same bytes render from two directories', () => {
  assert.deepEqual(relativeTargets(canonical), []);
  assert.ok(readmeTargets(canonical).length > 0);
});

test('every image is an https badge for this package', () => {
  const images = readmeImageUrls(canonical);
  assert.ok(images.length > 0, 'the badge row should not be empty');
  for (const url of images) {
    assert.match(url, /^https:\/\//, `${url} must be absolute https`);
  }
  // The npm badges must name this package, not a neighbour's.
  assert.ok(images.some((url) => url.includes('/npm/v/usebeeline')));
  assert.ok(images.some((url) => url.includes('/npm/dm/usebeeline')));
});

test('badge verdicts reject a service answering "not found"', () => {
  const svg = '<svg><title>stars: repo not found</title></svg>';
  assert.equal(badgeTitle(svg), 'stars: repo not found');
  assert.match(
    badgeVerdict({ status: 200, contentType: 'image/svg+xml', body: svg }),
    /renders as/,
  );
  assert.equal(
    badgeVerdict({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg><title>npm: v0.0.44</title></svg>',
    }),
    undefined,
  );
  assert.match(badgeVerdict({ status: 404, contentType: 'image/svg+xml' }), /HTTP 404/);
  assert.match(badgeVerdict({ status: 200, contentType: 'text/html' }), /not an image/);
});

test('a badge service having a bad day is skipped, not failed', async () => {
  assert.ok(isTransientStatus(503) && isTransientStatus(429));
  assert.ok(!isTransientStatus(404) && !isTransientStatus(200));

  const outage = async () => new Response('', { status: 503 });
  assert.deepEqual(await verifyBadges(['https://example.test/a.svg'], outage), {
    failures: [],
    unreachable: ['https://example.test/a.svg — HTTP 503'],
  });

  const offline = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  const { failures, unreachable } = await verifyBadges(['https://example.test/a.svg'], offline);
  assert.deepEqual(failures, []);
  assert.equal(unreachable.length, 1);

  const missing = async () => new Response('', { status: 404 });
  const definitive = await verifyBadges(['https://example.test/a.svg'], missing);
  assert.equal(definitive.failures.length, 1);
  assert.match(definitive.failures[0], /HTTP 404/);
});

test('--check reports drift instead of writing it away', (t) => {
  const original = fs.readFileSync(MIRROR, 'utf8');
  t.after(() => fs.writeFileSync(MIRROR, original));
  fs.writeFileSync(MIRROR, `${original}stale\n`);
  const problems = syncReadme({ check: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /readme:sync/);
  assert.equal(fs.readFileSync(MIRROR, 'utf8'), `${original}stale\n`, '--check must not write');
  assert.deepEqual(syncReadme(), []);
  assert.equal(fs.readFileSync(MIRROR, 'utf8'), original);
});
