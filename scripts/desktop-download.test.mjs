import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DESKTOP_INSTALLERS,
  selectDesktopInstaller,
} from '../relay-stack/web/desktop-download.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'relay-stack/web/index.html'), 'utf8');
const desktopWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/desktop.yml'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/unified-release.yml'), 'utf8');

const cases = [
  [
    'Windows x64',
    { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' },
    'windows',
  ],
  [
    'macOS Intel',
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel' },
    'macos',
  ],
  [
    'macOS Apple silicon',
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel' },
    'macos',
  ],
  [
    'Linux x64',
    { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' },
    'linux',
  ],
  [
    'iOS',
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone' },
    undefined,
  ],
  [
    'iPad desktop mode',
    {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    },
    undefined,
  ],
  [
    'Android',
    { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile', platform: 'Linux armv8l' },
    undefined,
  ],
  ['unknown', { userAgent: 'ExampleBrowser/1.0', platform: '' }, undefined],
  ['reduced Windows without architecture', { userAgent: 'Mozilla/5.0', uaDataPlatform: 'Windows' }, undefined],
  ['Windows ARM', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; ARM64)', platform: 'Win32' }, undefined],
];

for (const [name, input, expected] of cases) {
  test(`platform selection: ${name}`, () => {
    assert.equal(selectDesktopInstaller(input)?.platform, expected);
  });
}

test('the chooser contains only stable installable release assets', () => {
  assert.deepEqual(
    DESKTOP_INSTALLERS.map(({ asset }) => asset),
    [
      'Beeline-universal.dmg',
      'Beeline-x86_64-setup.exe',
      'Beeline-x86_64.msi',
      'Beeline-x86_64.AppImage',
      'Beeline-x86_64.deb',
      'Beeline-x86_64.rpm',
    ],
  );
  for (const installer of DESKTOP_INSTALLERS) {
    assert.match(
      installer.url,
      /^https:\/\/github\.com\/Beeline-Work\/beeline\/releases\/latest\/download\//,
    );
    assert.doesNotMatch(installer.asset, /(?:\.sig|\.sha\d*|checksums?|source|\.zip|\.tar\.gz)$/i);
    assert.match(html, new RegExp(`releases/latest/download/${installer.asset.replace('.', '\\.')}`));
  }
  assert.match(html, /data-desktop-download/);
  assert.match(html, /<summary>Other platforms<\/summary>/);
  assert.match(html, /src="\/desktop-download\.mjs"/);
});

test('the unified release publishes every stable website installer name', () => {
  assert.match(desktopWorkflow, /workflow_call:/);
  assert.match(desktopWorkflow, /if: inputs\.variant == 'production'/);
  assert.match(releaseWorkflow, /desktop_installers:/);
  assert.match(releaseWorkflow, /needs: \[initialize, server, helper, mobile_ota, mobile_native, desktop_installers/);
  for (const { asset } of DESKTOP_INSTALLERS) {
    assert.match(desktopWorkflow, new RegExp(asset.replace('.', '\\.')));
  }
  assert.match(releaseWorkflow, /assets=\("\$RUNNER_TEMP"\/desktop-release\/Beeline-\*\)/);
  assert.match(releaseWorkflow, /gh release create[\s\S]*"\$\{assets\[@\]\}"/);
  assert.match(releaseWorkflow, /gh release upload[\s\S]*"\$\{assets\[@\]\}"/);
  assert.match(releaseWorkflow, /gh release download "\$previous_version" --pattern 'Beeline-\*'/);
});
