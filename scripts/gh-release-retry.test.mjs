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
  if [[ "$2" == */commits/v* ]] && [ "\${GHR_FAKE_TAGLESS:-}" = true ]; then
    echo 'HTTP 422: No commit found for SHA' >&2
    exit 1
  fi
  if [[ "$2" == */releases ]]; then
    printf '%s\\n' "\${GHR_FAKE_RESERVED:-}"
    exit 0
  fi
  [ -z "\${GHR_FAKE_TAG_SHA:-}" ] || printf '%s\\n' "$GHR_FAKE_TAG_SHA"
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
    fail_or_pass "$GHR_FAKE_VIEW_FAILURES" || exit 1
    if [ ! -f "$GHR_FAKE_RELEASE" ]; then
      echo "release not found: $1" >&2
      exit 1
    fi
    if [[ " $* " == *" --json isDraft "* ]]; then
      [ -f "$GHR_FAKE_DRAFT" ] && echo true || echo false
    elif [[ " $* " == *" --json isDraft,targetCommitish "* ]]; then
      if [ -f "$GHR_FAKE_DRAFT" ]; then
        printf 'true\\t%s\\n' "\${GHR_FAKE_TARGET:-}"
      else
        printf 'false\\tmain\\n'
      fi
    else
      cat "$GHR_FAKE_ASSETS" 2>/dev/null
    fi
    exit 0
    ;;
  create)
    shift # release tag
    fail_or_pass "$GHR_FAKE_CREATE_FAILURES" || exit 1
    touch "$GHR_FAKE_RELEASE"
    [[ " $* " == *" --draft "* ]] && touch "$GHR_FAKE_DRAFT"
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
  edit)
    shift # release tag
    fail_or_pass "$GHR_FAKE_EDIT_FAILURES" || exit 1
    [[ " $* " == *" --draft=false "* ]] && rm -f "$GHR_FAKE_DRAFT"
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
  editFailures: 'GHR_FAKE_EDIT_FAILURES',
  deleteFailures: 'GHR_FAKE_DELETE_FAILURES',
  apiFailures: 'GHR_FAKE_API_FAILURES',
  viewFailures: 'GHR_FAKE_VIEW_FAILURES',
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
    draft: join(dir, 'release-draft'),
  };
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    GHR_BACKOFF_SECONDS: '0.02 0.02',
    GHR_FAKE_LOG: paths.log,
    GHR_FAKE_ASSETS: paths.assets,
    GHR_FAKE_RELEASE: paths.release,
    GHR_FAKE_DRAFT: paths.draft,
    SHA: 'a'.repeat(40),
    GITHUB_REPOSITORY: 'o/r',
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
  if (presets.tagless) env.GHR_FAKE_TAGLESS = 'true';
  if (presets.target) env.GHR_FAKE_TARGET = presets.target;
  if (presets.tagSha) env.GHR_FAKE_TAG_SHA = presets.tagSha;
  if (presets.releaseExists) writeFileSync(paths.release, '');
  if (presets.draftExists) writeFileSync(paths.draft, '');
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

test('ghr_create: persistent create denial leaves no release to ship against', (t) => {
  const { result, calls } = runHelper(t, 'ghr_create myrel --target "$SHA" --draft', {
    createFailures: 5,
  });
  assert.notEqual(result.status, 0);
  assert.equal(calls().filter((line) => line.startsWith('release create myrel')).length, 5);
  assert.match(result.stderr, /failed after 5 attempts/);
});

test('ghr_publish: retries a transient edit failure and confirms the draft became public', (t) => {
  const { result, calls } = runHelper(t, 'ghr_publish myrel "$NOTES"', {
    releaseExists: true, draftExists: true, editFailures: 1,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((line) => line.startsWith('release edit myrel')).length, 2);
  assert.ok(calls().some((line) => line.includes('--draft=false --latest')));
});

test('ghr_publish: persistent edit denial fails while the release stays draft', (t) => {
  const { result, calls } = runHelper(t, 'ghr_publish myrel "$NOTES"', {
    releaseExists: true, draftExists: true, editFailures: 3,
  });
  assert.notEqual(result.status, 0);
  assert.equal(calls().filter((line) => line.startsWith('release edit myrel')).length, 3);
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

test('ghr_requested_version_guard: fails when the existing release tag points at another commit', (t) => {
  const { result, calls } = runHelper(t, 'ghr_requested_version_guard v0.1.0 "$SHA"', {
    releaseExists: true, tagSha: 'b'.repeat(40),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`::error::requested version v0\\.1\\.0 .*${'b'.repeat(40)}.*${'a'.repeat(40)}`));
  assert.ok(calls().includes('api repos/o/r/commits/v0.1.0 --jq .sha'));
});

test('ghr_requested_version_guard: passes a retry whose release tag is already at the release SHA', (t) => {
  const { result } = runHelper(t, 'ghr_requested_version_guard v0.1.0 "$SHA"', {
    releaseExists: true, tagSha: 'a'.repeat(40),
  });
  assert.equal(result.status, 0, result.stderr);
});

test('ghr_requested_version_guard: passes a version with no existing release', (t) => {
  const { result, calls } = runHelper(t, 'ghr_requested_version_guard v0.1.0 "$SHA"', { tagSha: 'b'.repeat(40) });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!calls().some((line) => line.startsWith('api ')));
});

test('ghr_requested_version_guard: fails closed when the release lookup keeps failing', (t) => {
  const { result, calls } = runHelper(t, 'ghr_requested_version_guard v0.1.0 "$SHA"', {
    viewFailures: 99, tagSha: 'b'.repeat(40),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::could not confirm whether requested version v0\.1\.0 already has a GitHub release/);
  assert.equal(calls().filter((line) => line.startsWith('release view v0.1.0')).length, 5);
});

test('ghr_requested_version_guard: retries a transient lookup failure before checking the tag', (t) => {
  const { result } = runHelper(t, 'ghr_requested_version_guard v0.1.0 "$SHA"', {
    viewFailures: 2, releaseExists: true, tagSha: 'b'.repeat(40),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`::error::requested version v0\\.1\\.0 .*${'b'.repeat(40)}`));
});

test('initialize guards only a requested version against an existing release at another commit', () => {
  const step = WORKFLOW.match(/- name: Assign identity and produce the inspectable release plan[\s\S]*?release_id="/)?.[0];
  assert.ok(step, 'identity step found in unified-release.yml');
  assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(step, /\. scripts\/gh-release-retry\.sh/);
  const requested = step.match(/if \[ -n "\$REQUESTED_VERSION" \]; then([\s\S]*?)\n\s*else/)?.[1];
  assert.ok(requested, 'requested-version branch found');
  assert.match(requested, /ghr_requested_version_guard "\$release_version" "\$\(git rev-parse --verify "\$release_sha\^\{commit\}"\)"/);
  assert.equal(step.match(/ghr_requested_version_guard/g).length, 1, 'auto-computed and plan-only versions are not guarded');
});

test('release_result routes every release-mutating gh call through the retry wrappers', () => {
  const job = WORKFLOW.match(/^  release_result:[\s\S]*$/m)?.[0];
  assert.ok(job, 'release_result job found in unified-release.yml');
  assert.match(job, /\. scripts\/gh-release-retry\.sh/);
  // No bare release-mutating call may remain in the job (view/download are
  // read-only and stay bare; gh api does not appear in this job at all).
  assert.doesNotMatch(job, /^\s*gh release (upload|create|delete-asset|edit) /m);
  assert.doesNotMatch(job, /^\s*gh api /m);
  // The manifest remains the final, independently verified commit point, and
  // the rollback trap keeps its best-effort `|| true`.
  assert.match(job, /ghr_upload_verified "\$RELEASE_VERSION" "\$manifest"/);
  assert.match(job, /ghr_publish "\$RELEASE_VERSION" "\$notes"/);
  assert.match(job, /ghr_upload_verified "\$RELEASE_VERSION" "\$previous#Beeline-latest\.json" \|\| true/);
  assert.match(job, /ghr_delete_asset "\$RELEASE_VERSION" 'Beeline-latest\.json' \|\| true/);
});

test('the release record draft is created at record time, reused by a recovery, and guarded for pinned versions', () => {
  const initialize = WORKFLOW.match(/^  initialize:[\s\S]*?^  [a-z][\w-]*:/m)?.[0];
  assert.ok(initialize);
  // No pre-ship draft: planning only guards a pinned recovery version.
  assert.doesNotMatch(initialize, /ghr_create/);
  assert.match(initialize, /ghr_requested_version_guard "\$release_version"/);
  const releaseResult = WORKFLOW.match(/^  release_result:[\s\S]*$/m)?.[0];
  const create = releaseResult.indexOf('ghr_create "$RELEASE_VERSION"');
  assert.ok(create > 0);
  assert.match(releaseResult, /if ! gh release view "\$RELEASE_VERSION" >\/dev\/null 2>&1; then\n\s*ghr_create "\$RELEASE_VERSION"[^\n]*--draft/);
  assert.ok(create < releaseResult.indexOf('ghr_upload_verified "$RELEASE_VERSION" "$manifest"'));
});

for (const same of [true, false]) {
  test(`Reproduction tagless-draft: ${same ? 'reuse same SHA' : 'reject different SHA with recovery'}`, (t) => {
    const target = (same ? 'a' : 'b').repeat(40);
    const { result, calls } = runHelper(t, 'ghr_requested_version_guard v0.1.64 "$SHA"', {
      releaseExists: true, draftExists: true, tagless: true, target,
    });
    if (same) assert.equal(result.status, 0, result.stderr);
    else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /draft v0\.1\.64/);
      assert.ok(result.stderr.includes(target));
      assert.match(result.stderr, /rerun.*recovery/);
      assert.match(result.stderr, /delete.*only if nothing shipped/);
    }
    assert.ok(!calls().some((line) => /^release (create|edit|upload|delete)/.test(line)));
  });
}

for (const fixture of [
  { name: 'published release with missing tag', target: 'a'.repeat(40) },
  { name: 'draft with a moving branch target', draftExists: true, target: 'main' },
  { name: 'draft with an empty target', draftExists: true },
  { name: 'draft during an API outage', draftExists: true, target: 'a'.repeat(40), apiFailures: 99 },
]) {
  test(`ghr_requested_version_guard: fails closed for ${fixture.name}`, (t) => {
    const { result } = runHelper(t, 'ghr_requested_version_guard v0.1.64 "$SHA"', {
      releaseExists: true, tagless: true, ...fixture,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tag commit could not be resolved/);
  });
}

test('ghr_requested_version_guard: existing draft tag wins over its target', (t) => {
  const { result } = runHelper(t, 'ghr_requested_version_guard v0.1.64 "$SHA"', {
    releaseExists: true, draftExists: true, target: 'a'.repeat(40), tagSha: 'b'.repeat(40),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /whose tag points at b{40}/);
});

for (const exists of [true, false]) {
  test(`release record ${exists ? 'reuses the existing draft' : 'creates a draft'} before publishing`, (t) => {
    const snippet = WORKFLOW.match(/(if ! gh release view "\$RELEASE_VERSION" >\/dev\/null 2>&1; then[\s\S]*?\n\s*fi)\n/)?.[1];
    assert.ok(snippet);
    const body = snippet.replace(/^          /gm, '');
    const { result, calls } = runHelper(t, `. '${HELPER}'\nRELEASE_VERSION=v0.1.64\nRELEASE_SHA="$SHA"\n${body}`, {
      releaseExists: exists, draftExists: exists, target: 'a'.repeat(40),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls().some((line) => /^release create v0\.1\.64 .*--draft/.test(line)), !exists);
  });
}

test('ghr_requested_version_guard: transient commit lookup errors do not contaminate the SHA', (t) => {
  const { result } = runHelper(t, 'ghr_requested_version_guard v0.1.64 "$SHA"', {
    releaseExists: true, tagSha: 'a'.repeat(40), apiFailures: 2,
  });
  assert.equal(result.status, 0, result.stderr);
});

// Execute the routine allocation shell from initialize with a fake GitHub API,
// then pass its version into the real planner. No deploy or real API is used.
const routineAllocation = WORKFLOW.match(/(# Every existing record reserves its version[\s\S]*?release_version=\$\(node scripts\/unified-release\.mjs "\$\{version_args\[@\]\}"\))/)?.[1]
  ?.replace(/^              /gm, '')
  .replace('node scripts/unified-release.mjs', `node '${join(REPO, 'scripts/unified-release.mjs')}'`);

for (const fixture of [
  { name: 'terminated v0.1.71 draft after successful v0.1.70', reserved: ['v0.1.71'], expected: 'v0.1.72' },
  { name: 'multiple reserved drafts and published records', reserved: ['v0.1.71', 'v0.1.72', 'v0.1.73'], expected: 'v0.1.74' },
  { name: 'no abandoned draft', reserved: [], expected: 'v0.1.71' },
  { name: 'repeat successful HEAD remains a no-op', reserved: ['v0.1.70', 'v0.1.71'], sameSource: true, expected: 'v0.1.70' },
  { name: 'first release skips a reserved draft', reserved: ['v0.0.1'], noPrevious: true, expected: 'v0.0.2' },
]) {
  test(`routine initialize: ${fixture.name}`, (t) => {
    assert.ok(routineAllocation, 'routine workflow allocation found');
    const oldSha = 'b'.repeat(40);
    const { result, calls } = runHelper(t, `
      export RUNNER_TEMP="$PWD"
      export GHR_FAKE_RESERVED='${fixture.reserved.join('\n')}'
      release_sha="$SHA"
      previous="$PWD/previous.json"
      node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({version:"v0.1.70",sourceSha:process.argv[2]}))' "$previous" '${fixture.sameSource ? 'a'.repeat(40) : oldSha}'
      ${fixture.noPrevious ? 'rm "$previous"' : ''}
      # Failed components may already have shipped. Its immutable draft stays
      # reserved even though the identity can never be retried.
      printf '%s' '{"version":"v0.1.71","sourceSha":"${oldSha}","terminated":true}' > terminated-attempt.json
      ${routineAllocation}
      echo "allocated=$release_version"
      ${fixture.sameSource ? '' : `node '${join(REPO, 'scripts/unified-release.mjs')}' plan --version "$release_version" --sha "$release_sha" --selection all --state "$PWD/new-state.json" --summary "$PWD/plan.json"`}
      test -f terminated-attempt.json
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`allocated=${fixture.expected.replaceAll('.', '\\.')}(?:\\n|$)`));
    assert.ok(calls().includes("api repos/o/r/releases --paginate --jq .[].tag_name"));
    assert.ok(!calls().some((line) => /^release (create|edit|upload|delete)/.test(line)), 'allocation preserves every existing record and asset');
  });
}

test('routine initialize fails closed when reserved versions cannot be read', (t) => {
  assert.ok(routineAllocation);
  const { result, calls } = runHelper(t, `
    export RUNNER_TEMP="$PWD"
    previous="$PWD/missing.json"
    release_sha="$SHA"
    ${routineAllocation}
  `, { apiFailures: 99 });
  assert.notEqual(result.status, 0);
  assert.equal(calls().length, 5);
  assert.match(result.stderr, /giving up/);
});
