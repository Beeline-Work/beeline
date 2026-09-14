import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDesktopUpdateManifest,
  nextDesktopVersion,
  normalizeDesktopVersion,
  updaterBuildConfig,
  verifyDesktopUpdateManifest,
} from './desktop-update.mjs';

test('desktop versions are independent normalized semver patch counters', () => {
  assert.equal(normalizeDesktopVersion('v0.2.20'), '0.2.20');
  assert.equal(nextDesktopVersion('0.2.20'), '0.2.21');
  assert.equal(nextDesktopVersion('2.9.99'), '2.9.100');
  assert.throws(() => nextDesktopVersion('release-20'), /invalid desktop version/);
});

test('production config enables signed artifacts and passive NSIS updates', () => {
  assert.deepEqual(updaterBuildConfig({
    version: '0.2.21',
    publicKey: 'PUBLIC KEY',
    endpoint: 'https://github.com/Beeline-Work/beeline/releases/latest/download/Beeline-latest.json',
  }), {
    version: '0.2.21',
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey: 'PUBLIC KEY',
        endpoints: ['https://github.com/Beeline-Work/beeline/releases/latest/download/Beeline-latest.json'],
        windows: { installMode: 'passive' },
      },
    },
  });
  assert.throws(() => updaterBuildConfig({ version: '0.2.21', publicKey: '', endpoint: 'https://example.com' }), /required/);
  assert.throws(() => updaterBuildConfig({ version: '0.2.21', publicKey: 'key', endpoint: 'http://example.com' }), /HTTPS/);
});

test('manifest uses signed NSIS and shared universal macOS payloads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-update-'));
  try {
    for (const file of [
      'Beeline-universal.app.tar.gz',
      'Beeline-x86_64.AppImage',
      'Beeline-x86_64-setup.exe',
    ]) writeFileSync(join(directory, `${file}.sig`), `signature:${file}\n`);
    const manifest = createDesktopUpdateManifest({
      directory,
      version: '0.2.21',
      releaseTag: 'v0.0.81',
      repository: 'Beeline-Work/beeline',
      publishedAt: '2026-09-14T12:00:00Z',
    });
    assert.equal(manifest.version, '0.2.21');
    assert.equal(manifest.platforms['windows-x86_64'].url, 'https://github.com/Beeline-Work/beeline/releases/download/v0.0.81/Beeline-x86_64-setup.exe');
    assert.equal(manifest.platforms['darwin-aarch64'].url, manifest.platforms['darwin-x86_64'].url);
    assert.match(manifest.platforms['windows-x86_64'].signature, /^signature:/);
    assert.equal(verifyDesktopUpdateManifest(manifest, structuredClone(manifest)), manifest);
    assert.throws(() => verifyDesktopUpdateManifest({ ...manifest, version: '0.2.20' }, manifest), /differs/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release workflow keeps signing keys vaulted and rolls back the manifest commit point', () => {
  const desktopWorkflow = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8');
  const releaseWorkflow = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  const tauriConfig = JSON.parse(readFileSync(new URL('../apps/mobile/src-tauri/tauri.conf.json', import.meta.url)));
  assert.equal(tauriConfig.version, 'desktop-version.json');
  assert.match(desktopWorkflow, /TAURI_SIGNING_PRIVATE_KEY:.*secrets\.TAURI_UPDATER_PRIVATE_KEY/);
  assert.match(desktopWorkflow, /TAURI_UPDATER_PUBLIC_KEY:.*secrets\.TAURI_UPDATER_PUBLIC_KEY/);
  assert.match(desktopWorkflow, /workflow_dispatch:[\s\S]*desktop_version:/);
  assert.match(desktopWorkflow, /one '\*\.exe\.sig' 'Beeline-x86_64-setup\.exe\.sig'/);
  assert.match(releaseWorkflow, /desktop_version:.*steps\.plan\.outputs\.desktop_version/);
  assert.match(releaseWorkflow, /release_assets\+=\("\$previous"\)/);
  assert.match(releaseWorkflow, /\/releases\/latest never points at a half-published/);
  assert.match(releaseWorkflow, /The manifest is the commit point/);
  assert.match(releaseWorkflow, /trap rollback_manifest ERR/);
  assert.match(releaseWorkflow, /desktop-update\.mjs verify/);
});
