import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MACOS_SIGNING_CREDENTIALS,
  UNSIGNED_MACOS_NOTICE,
  desktopSigningDecision,
} from './desktop-signing.mjs';

const completeCredentials = Object.fromEntries(MACOS_SIGNING_CREDENTIALS.map((name) => [name, 'present']));
const desktopWorkflow = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
const tauriConfig = JSON.parse(readFileSync(new URL('../apps/mobile/src-tauri/tauri.conf.json', import.meta.url)));
const gateScript = fileURLToPath(new URL('./desktop-signing.mjs', import.meta.url));

test('enables signing only for a macOS production build with every credential', () => {
  assert.deepEqual(
    desktopSigningDecision({
      platform: 'macOS',
      variant: 'production',
      env: completeCredentials,
    }),
    { enabled: true, missing: [], reason: 'credentials-present' },
  );
});

test('selects a wholly unsigned production build when any signing credential is missing', () => {
  const env = { ...completeCredentials, MACOS_APPLE_CERTIFICATE: '' };
  assert.deepEqual(
    desktopSigningDecision({ platform: 'macOS', variant: 'production', env }),
    {
      enabled: false,
      missing: ['MACOS_APPLE_CERTIFICATE'],
      reason: 'credentials-missing',
    },
  );
});

test('allows a loud unsigned production build when the complete secret set is absent', () => {
  assert.equal(
    desktopSigningDecision({ platform: 'macOS', variant: 'production', env: {} }).reason,
    'credentials-missing',
  );
});

test('trusted preview builds exercise the signed path when repository secrets are available', () => {
  assert.deepEqual(
    desktopSigningDecision({
      platform: 'macOS',
      variant: 'preview',
      env: completeCredentials,
    }),
    { enabled: true, missing: [], reason: 'credentials-present' },
  );
});

test('dev builds stay unsigned even when repository secrets are available', () => {
  assert.deepEqual(
    desktopSigningDecision({ platform: 'macOS', variant: 'dev', env: completeCredentials }),
    { enabled: false, missing: [], reason: 'unsigned-variant' },
  );
});

test('non-macOS runners never receive signing credentials', () => {
  assert.deepEqual(
    desktopSigningDecision({
      platform: 'Linux',
      variant: 'production',
      env: completeCredentials,
    }),
    { enabled: false, missing: [], reason: 'not-macos' },
  );
});

test('the CLI permits an unsigned release and records the exact notice in its job summary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-signing-test-'));
  const output = join(directory, 'github-output');
  const summary = join(directory, 'github-summary');
  try {
    const result = spawnSync(process.execPath, [gateScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_OS: 'macOS',
        VARIANT: 'production',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        ...Object.fromEntries(MACOS_SIGNING_CREDENTIALS.map((name) => [name, ''])),
      },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`::warning::${UNSIGNED_MACOS_NOTICE}`));
    assert.equal(readFileSync(output, 'utf8'), 'enabled=false\n');
    assert.match(readFileSync(summary, 'utf8'), new RegExp(`^### ${UNSIGNED_MACOS_NOTICE}`, 'm'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI makes the signed path mandatory when every secret is present', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-signing-test-'));
  const output = join(directory, 'github-output');
  try {
    const result = spawnSync(process.execPath, [gateScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_OS: 'macOS',
        VARIANT: 'production',
        GITHUB_OUTPUT: output,
        ...completeCredentials,
      },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /macOS production signing and notarization are enabled/);
    assert.doesNotMatch(result.stdout, new RegExp(UNSIGNED_MACOS_NOTICE));
    assert.equal(readFileSync(output, 'utf8'), 'enabled=true\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the release permits missing secrets but makes a configured signed path mandatory', () => {
  assert.match(releaseWorkflow, /desktop_installers:[\s\S]*variant: production[\s\S]*secrets: inherit/);
  assert.doesNotMatch(releaseWorkflow, /require_macos_signing/);
  assert.match(releaseWorkflow, /macOS artifact UNSIGNED: signing secrets absent/);
  assert.match(desktopWorkflow, /scripts\/desktop-signing\.mjs/);
  assert.match(desktopWorkflow, /MACOS_APPLE_CERTIFICATE:.*secrets\.APPLE_CERTIFICATE/);
  assert.match(desktopWorkflow, /MACOS_APPLE_CERTIFICATE_PASSWORD:.*secrets\.APPLE_CERTIFICATE_PASSWORD/);
  assert.match(desktopWorkflow, /MACOS_APPLE_SIGNING_IDENTITY:.*secrets\.APPLE_SIGNING_IDENTITY/);
  assert.match(desktopWorkflow, /MACOS_ASC_KEY_ID:.*secrets\.EXPO_ASC_KEY_ID/);
  assert.match(desktopWorkflow, /MACOS_ASC_ISSUER_ID:.*secrets\.EXPO_ASC_ISSUER_ID/);
  assert.match(desktopWorkflow, /MACOS_ASC_API_KEY_P8:.*secrets\.EXPO_ASC_API_KEY_P8/);
  assert.match(desktopWorkflow, /write_env APPLE_CERTIFICATE "\$MACOS_APPLE_CERTIFICATE"/);
  assert.match(desktopWorkflow, /write_env APPLE_SIGNING_IDENTITY "\$MACOS_APPLE_SIGNING_IDENTITY"/);
  assert.match(desktopWorkflow, /'-----BEGIN'\*\).*printf '%s\\n'/);
  assert.match(desktopWorkflow, /echo "\$EXPO_ASC_API_KEY_P8" \| base64 -d > "\$key_path"/);
  assert.match(desktopWorkflow, /openssl pkey -in "\$key_path" -noout/);
  assert.match(desktopWorkflow, /write_env APPLE_API_KEY_PATH "\$key_path"/);
  assert.doesNotMatch(desktopWorkflow, /APPLE_CERTIFICATE:.*steps\.macos_signing\.outputs\.enabled/);
  assert.match(desktopWorkflow, /Unsigned preview assessment \(expected rejection\)/);
  assert.match(desktopWorkflow, /codesign --force --deep --sign - "\$test_app"/);
  assert.match(desktopWorkflow, /xcrun notarytool submit "\$dmg"[\s\S]*--wait --output-format json/);
  assert.match(desktopWorkflow, /codesign --verify --deep --strict --verbose=2 "\$app"/);
  assert.match(desktopWorkflow, /spctl --assess --type execute --verbose "\$app"/);
  assert.match(desktopWorkflow, /xcrun stapler validate "\$dmg"/);
  assert.match(desktopWorkflow, /Notarization log id: \$log_id/);
  assert.equal(
    desktopWorkflow.match(/if: steps\.macos_signing\.outputs\.enabled == 'true'/g)?.length,
    3,
  );
  assert.equal(tauriConfig.bundle.macOS.hardenedRuntime, true);
});
