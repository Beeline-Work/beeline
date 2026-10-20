import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = 'app.usebeeline';
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;

function run(script, env, { expectStatus = 0 } = {}) {
  const result = spawnSync('bash', [path.join(REPO, 'scripts', script)], {
    cwd: REPO,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, PLAY_DRY_RUN: '1', PACKAGE_NAME: PACKAGE, ...env },
  });
  assert.equal(result.status, expectStatus, `${script}\n${result.stdout}\n${result.stderr}`);
  const calls = result.stderr
    .split('\n')
    .filter((line) => line.startsWith('DRY-RUN '))
    .map((line) => line.slice('DRY-RUN '.length));
  return { ...result, calls };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-scripts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('play-publish.sh: edit → upload bundle → tracks.update → commit, notes from default.txt', (t) => {
  const dir = tempDir(t);
  const aab = path.join(dir, 'app.aab');
  fs.writeFileSync(aab, 'not really a bundle');
  const changelogs = path.join(dir, 'changelogs');
  fs.mkdirSync(changelogs);
  fs.writeFileSync(path.join(changelogs, 'default.txt'), 'Beta notes.\n');

  const { calls, stdout } = run('play-publish.sh', {
    AAB_PATH: aab,
    TRACK: 'internal',
    RELEASE_NAME: '0.2.18',
    RELEASE_STATUS: 'draft',
    CHANGELOG_DIR: changelogs,
    PLAY_DRY_RUN_VERSION_CODE: '28',
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[0], `POST ${API}/edits -H Content-Length: 0`);
  assert.equal(
    calls[1],
    `POST ${UPLOAD}/edits/dry-run-edit/bundles?uploadType=media -H Content-Type: application/octet-stream --data-binary @${aab}`,
  );
  const [, trackBody] = calls[2].match(/^PUT .*\/tracks\/internal -H Content-Type: application\/json --data (.*)$/s);
  assert.deepEqual(JSON.parse(trackBody), {
    track: 'internal',
    releases: [
      {
        name: '0.2.18',
        status: 'draft',
        versionCodes: ['28'],
        releaseNotes: [{ language: 'en-US', text: 'Beta notes.' }],
      },
    ],
  });
  assert.equal(
    calls[3],
    `POST ${API}/edits/dry-run-edit:commit?changesNotSentForReview=true -H Content-Length: 0`,
  );
  assert.match(stdout, /release notes from: .*default\.txt/);
  assert.match(stdout, /versionCode 28 is on the internal track as draft/);
  assert.match(stdout, new RegExp(`Play Console: https://play.google.com/console/u/0/developers/-/app-list\\?search=${PACKAGE}`));
  assert.doesNotMatch(calls.join('\n'), /Authorization/);
});

test('play-publish.sh prefers the per-versionCode changelog and refuses a missing AAB', (t) => {
  const dir = tempDir(t);
  const aab = path.join(dir, 'app.aab');
  fs.writeFileSync(aab, 'aab');
  const changelogs = path.join(dir, 'changelogs');
  fs.mkdirSync(changelogs);
  fs.writeFileSync(path.join(changelogs, 'default.txt'), 'default');
  fs.writeFileSync(path.join(changelogs, '31.txt'), 'exact notes for 31');
  const env = { AAB_PATH: aab, TRACK: 'beta', RELEASE_NAME: '0.2.19', RELEASE_STATUS: 'completed', CHANGELOG_DIR: changelogs };

  const { calls } = run('play-publish.sh', { ...env, PLAY_DRY_RUN_VERSION_CODE: '31' });
  assert.match(calls[2], /"text": "exact notes for 31"/);
  assert.match(calls[2], /"status": "completed"/);

  const missing = run('play-publish.sh', { ...env, AAB_PATH: path.join(dir, 'nope.aab') }, { expectStatus: 1 });
  assert.equal(missing.calls.length, 0);
  assert.match(missing.stderr, /AAB file not found/);
});

test('play-publish-listing.sh: one edit carrying text, cleared+uploaded images, validate, commit', (t) => {
  const dir = tempDir(t);
  const locale = path.join(dir, 'metadata', 'en-US');
  fs.mkdirSync(path.join(locale, 'images', 'phoneScreenshots'), { recursive: true });
  fs.writeFileSync(path.join(locale, 'title.txt'), 'Beeline\n');
  fs.writeFileSync(path.join(locale, 'short_description.txt'), 'Short "quoted" — copy\n');
  fs.writeFileSync(path.join(locale, 'full_description.txt'), 'Line one.\n\nLine two.\n');
  fs.writeFileSync(path.join(locale, 'images', 'icon.png'), 'icon');
  fs.writeFileSync(path.join(locale, 'images', 'featureGraphic.png'), 'feature');
  fs.writeFileSync(path.join(locale, 'images', 'phoneScreenshots', '02-corner.png'), 'b');
  fs.writeFileSync(path.join(locale, 'images', 'phoneScreenshots', '01-room.png'), 'a');

  const { calls } = run('play-publish-listing.sh', { METADATA_DIR: path.join(dir, 'metadata'), LANGUAGE: 'en-US' });

  assert.equal(calls[0], `POST ${API}/edits -H Content-Type: application/json -d {}`);
  const [, listingBody] = calls[1].match(/^PUT .*\/listings\/en-US -H Content-Type: application\/json -d (.*)$/s);
  assert.deepEqual(JSON.parse(listingBody), {
    language: 'en-US',
    title: 'Beeline',
    shortDescription: 'Short "quoted" — copy',
    fullDescription: 'Line one.\n\nLine two.',
  });
  const listings = `${API}/edits/dry-run-edit/listings/en-US`;
  const uploads = `${UPLOAD}/edits/dry-run-edit/listings/en-US`;
  assert.deepEqual(calls.slice(2), [
    `DELETE ${listings}/icon`,
    `POST ${uploads}/icon?uploadType=media -H Content-Type: image/png --data-binary @${locale}/images/icon.png`,
    `DELETE ${listings}/featureGraphic`,
    `POST ${uploads}/featureGraphic?uploadType=media -H Content-Type: image/png --data-binary @${locale}/images/featureGraphic.png`,
    `DELETE ${listings}/phoneScreenshots`,
    `POST ${uploads}/phoneScreenshots?uploadType=media -H Content-Type: image/png --data-binary @${locale}/images/phoneScreenshots/01-room.png`,
    `POST ${uploads}/phoneScreenshots?uploadType=media -H Content-Type: image/png --data-binary @${locale}/images/phoneScreenshots/02-corner.png`,
    `POST ${API}/edits/dry-run-edit:commit?changesNotSentForReview=true -H Content-Length: 0`,
  ]);
});

test('play-publish-listing.sh refuses an incomplete metadata dir before any call', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'en-US'), { recursive: true });
  const { calls, stderr } = run('play-publish-listing.sh', { METADATA_DIR: dir, LANGUAGE: 'en-US' }, { expectStatus: 1 });
  assert.equal(calls.length, 0);
  assert.match(stderr, /missing required listing asset: .*title\.txt/);
});

test('the committed listing publishes through the dry run', () => {
  const { calls } = run('play-publish-listing.sh', {
    METADATA_DIR: path.join(REPO, 'apps', 'mobile', 'fastlane', 'metadata', 'android'),
    LANGUAGE: 'en-US',
  });
  assert.equal(calls.filter((call) => call.includes('/phoneScreenshots?uploadType=media')).length, 4);
  assert.match(calls[1], /"title": "Beeline"/);
});

test('play-promote-track.sh: reads the source track and writes its newest release to the target', () => {
  const { calls, stdout } = run('play-promote-track.sh', {
    FROM_TRACK: 'internal',
    TO_TRACK: 'beta',
    RELEASE_STATUS: 'draft',
    PLAY_DRY_RUN_VERSION_CODE: '28',
  });
  assert.equal(calls[0], `POST ${API}/edits -H Content-Type: application/json -d {}`);
  assert.equal(calls[1], `GET ${API}/edits/dry-run-edit/tracks/internal`);
  const [, body] = calls[2].match(/^PUT .*\/tracks\/beta -H Content-Type: application\/json -d (.*)$/s);
  assert.deepEqual(JSON.parse(body), {
    track: 'beta',
    releases: [
      {
        name: 'dry-run-release',
        versionCodes: ['28'],
        status: 'draft',
        releaseNotes: [{ language: 'en-US', text: 'dry-run notes' }],
      },
    ],
  });
  assert.equal(
    calls[3],
    `POST ${API}/edits/dry-run-edit:commit?changesNotSentForReview=true -H Content-Length: 0`,
  );
  assert.equal(calls.length, 4);
  assert.match(stdout, /Ready to publish/);
});

test('without PLAY_DRY_RUN every script demands ACCESS_TOKEN before calling anything', () => {
  for (const script of ['play-publish.sh', 'play-publish-listing.sh', 'play-promote-track.sh']) {
    const result = spawnSync('bash', [path.join(REPO, 'scripts', script)], {
      cwd: REPO,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PACKAGE_NAME: PACKAGE },
    });
    assert.equal(result.status, 1, script);
    assert.match(result.stderr, /ACCESS_TOKEN env var is required/, script);
  }
});

// api() retry tests: stub curl with a fake on PATH that serves a scripted
// status sequence from PLAY_TEST_RESPONSES, then call api() directly.
function runApi(t, responses, extraEnv = {}) {
  const dir = tempDir(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/usr/bin/env bash
echo "$PLAY_TEST_RESPONSES" > "${dir}/responses"
n=$(ls "${dir}" | grep -c '^call-') || true
n=$((n+1))
echo "$n" > "${dir}/call-$n"
line=$(awk -v n="$n" 'NR==n {print; exit}' "${dir}/responses")
echo "$line"
# emulate curl -w "\\n%{http_code}" so api() can split body from status
prev=""
fmt=""
for a in "$@"; do
  if [[ "$prev" == "-w" || "$prev" == "--write-out" ]]; then fmt="$a"; fi
  prev="$a"
done
if [[ -n "$fmt" && "$fmt" == *http_code* ]]; then
  printf '\n%s' "$line"
fi
`,
  );
  fs.chmodSync(path.join(bin, 'curl'), 0o755);
  const result = spawnSync(
    'bash',
    ['-c', `source ${path.join(REPO, 'scripts', 'play-api.sh')}; api "$@"`, 'api', 'GET', `${API}/edits/1/tracks/internal`],
    {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        PACKAGE_NAME: PACKAGE,
        ACCESS_TOKEN: 'test-token',
        PLAY_TEST_RESPONSES: responses.join('\n'),
        ...extraEnv,
      },
    },
  );
  const calls = fs.readdirSync(dir).filter((f) => f.startsWith('call-')).length;
  return { result, calls };
}

test('api() retries a 503 and returns the eventual 200 body', (t) => {
  const { result, calls } = runApi(t, [503, 503, 200], { PLAY_RETRY_DELAYS: '0 0 0' });
  assert.equal(result.status, 0, `${result.stderr}`);
  assert.equal(result.stdout.trim(), '200');
  assert.equal(calls, 3);
  assert.match(result.stderr, /retrying in 0s \(retry 1 of 3\)/);
  assert.match(result.stderr, /retrying in 0s \(retry 2 of 3\)/);
});

test('api() fails after 3 retries with the ::error:: line when the 503 persists', (t) => {
  const { result, calls } = runApi(t, [503, 503, 503, 503], { PLAY_RETRY_DELAYS: '0 0 0' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::API call failed: GET .* → HTTP 503/);
  assert.match(result.stderr, /retry 3 of 3/);
  assert.equal(result.stdout.trim(), '');
  assert.equal(calls, 4);
});

test('api() retries a 429 the same way', (t) => {
  const { result, calls } = runApi(t, [429, 200], { PLAY_RETRY_DELAYS: '0' });
  assert.equal(result.status, 0, `${result.stderr}`);
  assert.equal(result.stdout.trim(), '200');
  assert.equal(calls, 2);
});

test('api() fails at once on a non-retryable 403 with no retry', (t) => {
  const { result, calls } = runApi(t, [403], { PLAY_RETRY_DELAYS: '0' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::API call failed: GET .* → HTTP 403/);
  assert.doesNotMatch(result.stderr, /retrying/);
  assert.equal(result.stdout.trim(), '');
  assert.equal(calls, 1);
});

// Bundle-upload case from the brief: a retried non-idempotent POST may meet
// "version code already used" (Play returns 409) when the first attempt landed
// server-side despite the 5xx. 409 is not retryable, so api() fails at once
// with the error output; the caller stops before commit_edit and the
// uncommitted edit is discarded — no duplicate artifact is published.
test("api() fails at once when a retried upload hits 'version code already used' (409)", (t) => {
  const { result, calls } = runApi(t, [503, 409], { PLAY_RETRY_DELAYS: '0' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::API call failed: GET .* → HTTP 409/);
  assert.doesNotMatch(result.stderr, /retry 2 of 3/);
  assert.equal(result.stdout.trim(), '');
  assert.equal(calls, 2);
});

test('api() succeeds on the first 200 without touching the retry path', (t) => {
  const { result, calls } = runApi(t, [200], { PLAY_RETRY_DELAYS: '0' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '200');
  assert.doesNotMatch(result.stderr, /retrying/);
  assert.equal(calls, 1);
});
