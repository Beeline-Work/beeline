import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MACOS_SIGNING_CREDENTIALS, desktopSigningDecision } from './desktop-signing.mjs';

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
      required: true,
      env: completeCredentials,
    }),
    { enabled: true, missing: [], reason: 'credentials-present' },
  );
});

test('fails closed before a release build when any signing credential is missing', () => {
  const env = { ...completeCredentials, MACOS_APPLE_CERTIFICATE: '' };
  assert.deepEqual(
    desktopSigningDecision({ platform: 'macOS', variant: 'production', required: true, env }),
    {
      enabled: false,
      missing: ['MACOS_APPLE_CERTIFICATE'],
      reason: 'required-credentials-missing',
    },
  );
});

test('allows a loud unsigned production build outside the release pipeline', () => {
  assert.equal(
    desktopSigningDecision({ platform: 'macOS', variant: 'production', required: false, env: {} }).reason,
    'optional-credentials-missing',
  );
});

test('preview builds stay unsigned even when repository secrets are available', () => {
  assert.deepEqual(
    desktopSigningDecision({
      platform: 'macOS',
      variant: 'preview',
      required: false,
      env: completeCredentials,
    }),
    { enabled: false, missing: [], reason: 'unsigned-variant' },
  );
});

test('non-macOS runners never receive signing credentials', () => {
  assert.deepEqual(
    desktopSigningDecision({
      platform: 'Linux',
      variant: 'production',
      required: true,
      env: completeCredentials,
    }),
    { enabled: false, missing: [], reason: 'not-macos' },
  );
});

test('the CLI fails a required release loudly and records a disabled output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-signing-test-'));
  const output = join(directory, 'github-output');
  try {
    const result = spawnSync(process.execPath, [gateScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_OS: 'macOS',
        VARIANT: 'production',
        REQUIRE_MACOS_SIGNING: 'true',
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::a released macOS artifact must be signed and notarized/);
    assert.equal(readFileSync(output, 'utf8'), 'enabled=false\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI makes an optional unsigned production build conspicuous', () => {
  const result = spawnSync(process.execPath, [gateScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RUNNER_OS: 'macOS',
      VARIANT: 'production',
      REQUIRE_MACOS_SIGNING: 'false',
      GITHUB_OUTPUT: '',
    },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^enabled=false/m);
  assert.match(result.stdout, /::warning::macOS production signing skipped because credentials are unavailable/);
});

test('the release requires signing before it can publish a macOS installer', () => {
  assert.match(releaseWorkflow, /desktop_installers:[\s\S]*require_macos_signing: true[\s\S]*secrets: inherit/);
  assert.match(desktopWorkflow, /APPLE_CERTIFICATE:.*secrets\.APPLE_CERTIFICATE/);
  assert.match(desktopWorkflow, /APPLE_CERTIFICATE_PASSWORD:.*secrets\.APPLE_CERTIFICATE_PASSWORD/);
  assert.match(desktopWorkflow, /MACOS_ASC_KEY_ID:.*secrets\.EXPO_ASC_KEY_ID/);
  assert.match(desktopWorkflow, /MACOS_ASC_ISSUER_ID:.*secrets\.EXPO_ASC_ISSUER_ID/);
  assert.match(desktopWorkflow, /MACOS_ASC_API_KEY_P8:.*secrets\.EXPO_ASC_API_KEY_P8/);
  assert.match(desktopWorkflow, /APPLE_SIGNING_IDENTITY:[\s\S]*Developer ID Application: Moon Rice Limited \(89KT3SWYAF\)/);
  assert.match(desktopWorkflow, /APPLE_API_KEY_PATH/);
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
