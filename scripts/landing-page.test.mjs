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
  assert.ok(localAssetPaths.length >= 9, 'expected self-hosted fonts and screenshots');
  for (const asset of localAssetPaths) {
    assert.ok(fs.existsSync(path.join(WEB, asset)), `missing landing asset: ${asset}`);
  }
});

test('landing page keeps store destinations at one replacement seam', () => {
  assert.match(html, /const STORE_URLS = \{/);
  assert.match(html, /appStore: ["']#ios-coming-soon["']/);
  assert.match(html, /googlePlay: ["']#android-coming-soon["']/);
  assert.equal((html.match(/const STORE_URLS/g) ?? []).length, 1);
  assert.equal((html.match(/data-store="appStore"/g) ?? []).length, 2);
  assert.equal((html.match(/data-store="googlePlay"/g) ?? []).length, 2);
});

test('landing page carries the approved product voice and developer hook', () => {
  assert.match(html, /Steer and review your AI coding agents from your phone\./);
  assert.match(html, /npx usebeeline connect/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /https:\/\/fonts\./);
});
