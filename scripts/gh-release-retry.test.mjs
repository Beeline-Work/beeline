import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(REPO, 'scripts', 'gh-release-retry.sh');
const WORKFLOW = readFileSync(join(REPO, '.github/workflows/unified-release.yml'), 'utf8');

// A fake `gh` that models the release API surface the wrappers use: uploads
// can be scripted to fail transiently (HTTP 500, as in run 35268976983) or to
// lie (exit 0 without storing the asset), so both the retry loop and the
// post-upload asset verification are exercised. Counter files hold how many
// times each command must fail before behaving; the release's asset state is
// a `name<TAB>size` table, matching the `--jq` projection the wrapper reads.
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GHR_FAKE_LOG"
fail_or_pass() {
  local counter="$1"
  if [ -f "$counter" ] && [ "$(cat "$counter")" -gt 0 ]; then
    echo $(( $(cat "$counter") - 1 )) > "$counter"
    echo "HTTP 500: Error saving asset" >&2
    return 1
  fi
  return 0
}
record_asset() {
  local local_path="$1" name size
  name=$(basename "$local_path")
  size=$(wc -c < "$local_path")
  grep -v "^$name"$'\\t' "$GHR_FAKE_ASSETS" 2>/dev/null > "$GHR_FAKE_ASSETS.tmp" || true
  printf '%s\\t%s\\n' "$name" "$size" >> "$GHR_FAKE_ASSETS.tmp"
  mv "$GHR_FAKE_ASSETS.tmp" "$GHR_FAKE_ASSETS"
}
if [ "$1" != release ]; then
  fail_or_pass "$GHR_FAKE_API_FAILURES" || exit 1
  exit 0
fi
sub="$2"; shift 2
case "$sub" in
  upload)
    shift # release tag
    fail_or_pass "$GHR_FAKE_UPLOAD_FAILURES" || exit 1
    if [ -f "$GHR_FAKE_SILENT_UPLOADS" ] && [ "$(cat "$GHR_FAKE_SILENT_UPLOADS")" -gt 0 ]; then
      echo $(( $(cat "$GHR_FAKE_SILENT_UPLOADS") - 1 )) > "$GHR_FAKE_SILENT_UPLOADS"
      exit 0
    fi
    touch "$GHR_FAKE_RELEASE"
    for f in "$@"; do
      [ "$f" = "--clobber" ] && continue
      record_asset "\${f%%#*}"
    done
    exit 0
    ;;
  view)
    if [ ! -f "$GHR_FAKE_RELEASE" ]; then
      echo "release not found: $1" >&2
      exit 1
    fi
    cat "$GHR_FAKE_ASSETS" 2>/dev/null
    exit 0
    ;;
  create)
    shift # release tag
    fail_or_pass "$GHR_FAKE_CREATE_FAILURES" || exit 1
    touch "$GHR_FAKE_RELEASE"
    skip_next=false
    for f in "$@"; do
      if [ "$skip_next" = true ]; then skip_next=false; continue; fi
      case "$f" in
        --target|--title|--notes|--notes-file|--discussion-category) skip_next=true; continue ;;
      esac
      [ -f "$f" ] && record_asset "$f"
    done
    exit 0
    ;;
  delete-asset)
    shift # release tag
    local_name="$1"
    fail_or_pass "$GHR_FAKE_DELETE_FAILURES" || exit 1
    grep -v "^$local_name"$'\\t' "$GHR_FAKE_ASSETS" 2>/dev/null > "$GHR_FAKE_ASSETS.tmp" || true
    mv "$GHR_FAKE_ASSETS.tmp" "$GHR_FAKE_ASSETS" 2>/dev/null || true
    exit 0
    ;;
esac
echo "fake gh: unhandled: $*" >&2
exit 64
`;

const PRESET_COUNTERS = {
  uploadFailures: 'GHR_FAKE_UPLOAD_FAILURES',
  silentUploads: 'GHR_FAKE_SILENT_UPLOADS',
  createFailures: 'GHR_FAKE_CREATE_FAILURES',
  deleteFailures: 'GHR_FAKE_DELETE_FAILURES',
  apiFailures: 'GHR_FAKE_API_FAILURES',
};

function runHelper(t, body, presets = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-release-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const paths = {
    log: join(dir, 'calls.log'),
    assets: join(dir, 'assets.tsv'),
    release: join(dir, 'release-exists'),
  };
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    GHR_BACKOFF_SECONDS: '0.02 0.02',
    GHR_FAKE_LOG: paths.log,
    GHR_FAKE_ASSETS: paths.assets,
    GHR_FAKE_RELEASE: paths.release,
    SHA: 'a'.repeat(40),
  };
  for (const [preset, counter] of Object.entries(PRESET_COUNTERS)) {
    env[counter] = join(dir, counter);
    if (presets[preset] !== undefined) writeFileSync(env[counter], String(presets[preset]));
  }
  // Fixtures referenced by every driver body: A/B are uploadable assets,
  // notes.md is a --notes-file value that must never be uploaded as an asset.
  const assetA = join(dir, 'a.bin');
  const assetB = join(dir, 'b.bin');
  const notes = join(dir, 'release-notes.md');
  writeFileSync(assetA, '12345');
  writeFileSync(assetB, '1234567');
  writeFileSync(notes, 'Release notes.\n');
  env.A = assetA;
  env.B = assetB;
  env.NOTES = notes;
  if (presets.releaseExists) writeFileSync(paths.release, '');
  if (presets.assets) writeFileSync(paths.assets, presets.assets);
  const driver = join(dir, 'driver.sh');
  writeFileSync(driver, `set -euo pipefail\n. '${HELPER}'\n${body.trim()}\n`);
  const result = spawnSync('bash', [driver], { cwd: dir, encoding: 'utf8', env });
  const calls = () => readFileSync(paths.log, 'utf8').split('\n').filter((line) => line.length > 0);
  const assets = () => Object.fromEntries(
    readFileSync(paths.assets, 'utf8').split('\n').filter((line) => line.includes('\t')).map((line) => line.split('\t')),
  );
  return { result, calls, assets };
}

test('ghr_upload_verified: confirms success by listing assets, not by exit code alone', (t) => {
  const { result, calls, assets } = runHelper(t, 'ghr_upload_verified myrel "$A"');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((line) => line.startsWith('release upload')).length, 1);
  assert.deepEqual(assets(), { 'a.bin': '5' });
});

test('ghr_upload_verified: retries transient HTTP 500s and succeeds', (t) => {
  const { result, calls, assets } = runHelper(t, 'ghr_upload_verified myrel "$A"', { uploadFailures: 2 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((line) => line.startsWith('release upload')).length, 3);
  assert.deepEqual(assets(), { 'a.bin': '5' });
});

test('ghr_upload_verified: catches an upload that exits 0 without storing the asset', (t) => {
  const { result, calls, assets } = runHelper(t, 'ghr_upload_verified myrel "$A"', { silentUploads: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((line) => line.startsWith('release upload')).length, 2);
  assert.deepEqual(assets(), { 'a.bin': '5' });
});

test('ghr_upload_verified: catches a listed size that mismatches the local bytes', (t) => {
  const { result, calls, assets } = runHelper(t, 'ghr_upload_verified myrel "$A"', {
    silentUploads: 1,
    assets: 'a.bin\t999\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((line) => line.startsWith('release upload')).length, 2);
  assert.deepEqual(assets(), { 'a.bin': '5' });
});

test('ghr_upload_verified: fails only after every attempt is spent', (t) => {
  const { result, calls } = runHelper(t, 'ghr_upload_verified myrel "$A" || echo "failed:$?"', {
    uploadFailures: 99,
  });
  assert.match(result.stdout, /failed:1/);
  assert.equal(calls().filter((line) => line.startsWith('release upload')).length, 5);
});

test('ghr_upload_verified: a file#label upload verifies under its basename', (t) => {
  const { result, calls, assets } = runHelper(t, 'ghr_upload_verified myrel "$A#Beeline-a.bin"');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((line) => line.startsWith('release upload')).length, 1);
  assert.ok(calls().some((line) => line.includes('#Beeline-a.bin')), 'the label reaches gh verbatim');
  assert.deepEqual(assets(), { 'a.bin': '5' });
});

test('ghr_upload_verified: re-uploading existing identical bytes is idempotent', (t) => {
  const { result, assets, calls } = runHelper(
    t,
    'ghr_upload_verified myrel "$A"\nghr_upload_verified myrel "$A"',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(assets(), { 'a.bin': '5' });
  assert.equal(calls().filter((line) => line.startsWith('release upload')).length, 2);
});

test('ghr_create: retries a transient failure of the create itself', (t) => {
  const { result, calls, assets } = runHelper(
    t,
    'ghr_create myrel --target "$SHA" --title myrel --notes-file "$NOTES" "$A"',
    { createFailures: 1 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((line) => line.startsWith('release create')).length, 2);
  assert.deepEqual(assets(), { 'a.bin': '5' });
});

test('ghr_create: recovers a partial create (release published, its asset upload failed)', (t) => {
  const { result, calls, assets } = runHelper(
    t,
    'ghr_create myrel --target "$SHA" --title myrel --notes-file "$NOTES" "$A" "$B"',
    {
      createFailures: 99,
      releaseExists: true,
      assets: 'old.bin\t11\n',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  // Create is NOT retried once the release exists; the missing positional
  // assets are clobbered on instead, and the notes file is never uploaded.
  assert.equal(calls().filter((line) => line.startsWith('release create')).length, 1);
  assert.equal(calls().filter((line) => line.startsWith('release upload')).length, 1);
  assert.deepEqual(assets(), { 'old.bin': '11', 'a.bin': '5', 'b.bin': '7' });
});

test('ghr_create: an assetless create over an existing release succeeds without uploading', (t) => {
  const { result, calls } = runHelper(t, 'ghr_create myrel --target "$SHA"', {
    createFailures: 99,
    releaseExists: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((line) => line.startsWith('release create')).length, 1);
  assert.equal(calls().filter((line) => line.startsWith('release upload')).length, 0);
});

test('ghr_delete_asset: retries a transient failure and removes the asset', (t) => {
  const { result, calls, assets } = runHelper(t, 'ghr_delete_asset myrel a.bin', {
    deleteFailures: 1,
    releaseExists: true,
    assets: 'a.bin\t5\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((line) => line.startsWith('release delete-asset')).length, 2);
  assert.deepEqual(assets(), {});
});

test('ghr_api: bounded retry around gh api', (t) => {
  const { result, calls } = runHelper(t, 'ghr_api repos/o/r/releases', { apiFailures: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((line) => line.startsWith('api repos/')).length, 2);
});

test('ghr_api: fails only after every attempt is spent', (t) => {
  const { result, calls } = runHelper(t, 'ghr_api repos/o/r/releases || echo "failed:$?"', {
    apiFailures: 99,
  });
  assert.match(result.stdout, /failed:1/);
  assert.equal(calls().filter((line) => line.startsWith('api repos/')).length, 5);
});

test('release_result routes every release-mutating gh call through the retry wrappers', () => {
  const job = WORKFLOW.match(/^  release_result:[\s\S]*?^  retry:/m)?.[0];
  assert.ok(job, 'release_result job found in unified-release.yml');
  assert.match(job, /\. scripts\/gh-release-retry\.sh/);
  // No bare release-mutating call may remain in the job (view/download are
  // read-only and stay bare; gh api does not appear in this job at all).
  assert.doesNotMatch(job, /^\s*gh release (upload|create|delete-asset) /m);
  assert.doesNotMatch(job, /^\s*gh api /m);
  // The manifest remains the final, independently verified commit point, and
  // the rollback trap keeps its best-effort `|| true`.
  assert.match(job, /ghr_upload_verified "\$RELEASE_VERSION" "\$manifest"/);
  assert.match(job, /ghr_upload_verified "\$RELEASE_VERSION" "\$previous#Beeline-latest\.json" \|\| true/);
  assert.match(job, /ghr_delete_asset "\$RELEASE_VERSION" 'Beeline-latest\.json' \|\| true/);
});
