import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'relay-stack', 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const termsHtml = fs.readFileSync(path.join(WEB, 'terms', 'index.html'), 'utf8');
const nginx = fs.readFileSync(path.join(ROOT, 'relay-stack', 'prod', 'nginx.conf'), 'utf8');

test('landing and terms pages ship from the production web root', () => {
  assert.match(nginx, /location = \/ \{/);
  assert.match(nginx, /try_files \/index\.html =404;/);
  assert.match(nginx, /location = \/terms \{/);
  assert.match(nginx, /location = \/terms\/ \{/);
  assert.match(nginx, /try_files \/terms\/index\.html =404;/);
  assert.match(nginx, /map "\$http_upgrade:\$http_accept" \$root_is_relay_request/);
  assert.match(nginx, /error_page 418 = @relay_root;/);
  assert.match(nginx, /location @relay_root \{/);
  assert.doesNotMatch(nginx, /location \^~ \/assets\/landing\//);
});

test('landing and terms pages load fonts from Google Fonts, not self-hosted assets', () => {
  assert.match(html, /https:\/\/fonts\.googleapis\.com/);
  assert.match(termsHtml, /https:\/\/fonts\.googleapis\.com/);
  assert.doesNotMatch(html, /assets\/landing\//);
  assert.doesNotMatch(termsHtml, /assets\/landing\//);
  assert.ok(!fs.existsSync(path.join(WEB, 'assets', 'landing')), 'old self-hosted landing assets should be removed');
});

test('nginx CSP for landing and terms allows the Google Fonts hosts they load from', () => {
  for (const location of [/location = \/ \{[\s\S]*?\n {4}\}/, /location = \/terms \{[\s\S]*?\n {4}\}/]) {
    const block = nginx.match(location)?.[0];
    assert.ok(block, `expected an nginx block matching ${location}`);
    assert.match(block, /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
    assert.match(block, /font-src[^;]*https:\/\/fonts\.gstatic\.com/);
  }
});

test('landing page links to the app stores and the terms/privacy pages', () => {
  assert.match(html, /https:\/\/apps\.apple\.com\/app\/id6803948500/);
  assert.match(html, /https:\/\/play\.google\.com\/store\/apps\/details\?id=app\.usebeeline\.mobile/);
  assert.match(html, /href="\/privacy\/"/);
  assert.match(html, /href="\/terms\/"/);
  assert.match(html, /npx usebeeline connect/);
});

test('terms page carries the beeline brand tokens and links home', () => {
  assert.match(termsHtml, /<title>Beeline Terms<\/title>/);
  assert.match(termsHtml, /--brass:#d7af5f/);
});
