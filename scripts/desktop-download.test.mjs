import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DESKTOP_INSTALLERS,
  initializePlatformDownloads,
  selectDesktopInstaller,
  selectPlatform,
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

function platformControls() {
  const tiles = ['ios', 'android', 'macos', 'windows', 'linux'].map((platform) => {
    const classes = new Set();
    const attributes = new Map();
    return {
      dataset: { platform },
      classList: {
        add: (value) => classes.add(value),
        remove: (value) => classes.delete(value),
        contains: (value) => classes.has(value),
      },
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
      getAttribute: (name) => attributes.get(name),
    };
  });
  return {
    tiles,
    documentLike: { querySelectorAll: () => tiles },
  };
}

test('Android lights only the Android tile even though its user agent also says Linux', async () => {
  const controls = platformControls();
  await initializePlatformDownloads(controls.documentLike, {
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile',
    platform: 'Linux armv8l',
  });

  assert.deepEqual(
    controls.tiles.filter((tile) => tile.classList.contains('is-current')).map((tile) => tile.dataset.platform),
    ['android'],
  );
  assert.equal(controls.tiles[1].getAttribute('aria-current'), 'true');
});

test('unknown visitors leave every platform tile muted', async () => {
  const controls = platformControls();
  await initializePlatformDownloads(controls.documentLike, {
    userAgent: 'ExampleBrowser/1.0',
    platform: '',
  });

  assert.equal(controls.tiles.some((tile) => tile.classList.contains('is-current')), false);
  assert.equal(selectPlatform({ userAgent: 'ExampleBrowser/1.0', platform: '' }), undefined);
});

test('landing markup exposes one main flow and one accessible animation description', () => {
  assert.match(html, /<main>[\s\S]*<\/main>/);
  assert.match(html, /<figure class="stage-wrap" aria-labelledby="stage-caption">/);
  assert.match(html, /<div class="stage" id="stage" aria-hidden="true" inert>/);
  assert.match(html, /<figcaption class="sr-only" id="stage-caption">/);
  assert.match(html, /a:focus-visible/);
  assert.match(html, /\.platform-tile\{[^}]*min-height:82px/);
  assert.match(html, /footer a\{display:inline-flex;align-items:center;min-height:44px/);
});

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
  }
  for (const asset of ['Beeline-universal.dmg', 'Beeline-x86_64-setup.exe', 'Beeline-x86_64.AppImage']) {
    assert.match(html, new RegExp(`releases/latest/download/${asset.replace('.', '\\.')}`));
  }
  assert.equal(html.match(/data-platform=/g)?.length, 5);
  assert.match(html, /src="\/desktop-download\.mjs\?v=platform-row"/);
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
