import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'relay-stack', 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const nginx = fs.readFileSync(path.join(ROOT, 'relay-stack', 'prod', 'nginx.conf'), 'utf8');

test('landing page ships from the production web root with local assets', () => {
  assert.match(nginx, /location = \/ \{/);
  assert.match(nginx, /try_files \/index\.html =404;/);
  assert.match(nginx, /location \^~ \/assets\/landing\//);
  assert.match(nginx, /map "\$http_upgrade:\$http_accept" \$root_is_relay_request/);
  assert.match(nginx, /error_page 418 = @relay_root;/);
  assert.match(nginx, /location @relay_root \{/);

  const localAssetPaths = [
    ...html.matchAll(/src=["'](assets\/landing\/[^"']+)["']/g),
    ...html.matchAll(/url\(["'](assets\/landing\/[^"']+)["']\)/g),
  ].map(([, asset]) => asset);
  assert.ok(localAssetPaths.length >= 8, 'expected self-hosted fonts and screenshots');
  for (const asset of localAssetPaths) {
    assert.ok(fs.existsSync(path.join(WEB, asset)), `missing landing asset: ${asset}`);
  }
});

test('landing page keeps store destinations at one replacement seam', () => {
  assert.match(html, /const APP_STORE_URL = ["']#ios-coming-soon["'];/);
  assert.match(html, /const GOOGLE_PLAY_URL = ["']#android-coming-soon["'];/);
  assert.equal((html.match(/const APP_STORE_URL/g) ?? []).length, 1);
  assert.equal((html.match(/const GOOGLE_PLAY_URL/g) ?? []).length, 1);
  assert.equal((html.match(/data-store="app-store"\s+href/g) ?? []).length, 1);
  assert.equal((html.match(/data-store="google-play"\s+href/g) ?? []).length, 1);
});

test('landing page carries the approved product voice and developer hook', () => {
  assert.match(html, /<span>workspace<\/span>/);
  assert.match(html, /<span>for all<\/span>/);
  assert.match(html, /<span>intelligence<\/span>/);
  assert.match(html, /--aubergine: #14091a;/);
  assert.match(html, /--brass: #d7af5f;/);
  assert.match(html, /Your people and your agents finally share the work\./);
  assert.match(html, /The human \+ agent assembly line/);
  assert.match(html, /Agents execute · humans accept/);
  assert.match(html, /npx usebeeline connect/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /https:\/\/fonts\./);
});

test('phone typography and gutters keep headings inside a 384px viewport', () => {
  const mobileCss = html.match(
    /@media \(max-width: 620px\) \{([\s\S]+?)\n      \}\n      @media \(prefers-reduced-motion/,
  )?.[1];
  assert.ok(mobileCss, 'expected the phone-width CSS block');
  assert.match(mobileCss, /--page: calc\(100vw - 32px\)/);
  assert.match(mobileCss, /\.hero h1 \{[\s\S]*?font-size: clamp\(2\.6rem, 12\.6vw, 3\.55rem\);/);
  assert.match(
    mobileCss,
    /\.thesis h2,[\s\S]*?\.connect h2 \{[\s\S]*?font-size: clamp\(2\.4rem, 11\.5vw, 3\.2rem\);/,
  );
});
