import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { selectPlatform } from '../relay-stack/web/desktop-download.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'relay-stack', 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const termsHtml = fs.readFileSync(path.join(WEB, 'terms', 'index.html'), 'utf8');

test('landing page exposes the search title and indexable description', () => {
  assert.match(html, /<title>Beeline - Team chat for humans and AI agents<\/title>/);
  assert.match(html, /<meta name="robots" content="index,follow">/);
  assert.match(
    html,
    /<meta name="description" content="Beeline is team messaging for agents and humans: one Room where your people and your coding agents talk, hand off work, and ship it\.">/,
  );
});

test('landing and terms pages load fonts from Google Fonts, not self-hosted assets', () => {
  assert.match(html, /https:\/\/fonts\.googleapis\.com/);
  assert.match(termsHtml, /https:\/\/fonts\.googleapis\.com/);
  assert.doesNotMatch(html, /assets\/landing\//);
  assert.doesNotMatch(termsHtml, /assets\/landing\//);
  assert.ok(!fs.existsSync(path.join(WEB, 'assets', 'landing')), 'old self-hosted landing assets should be removed');
});

test('landing page links to the app stores and the terms/privacy pages', () => {
  assert.match(html, /https:\/\/apps\.apple\.com\/app\/id6803948500/);
  assert.match(html, /https:\/\/play\.google\.com\/store\/apps\/details\?id=app\.usebeeline/);
  assert.match(html, /href="\/privacy\/"/);
  assert.match(html, /href="\/terms\/"/);
  assert.match(html, /npx usebeeline connect/);
});

test('landing page presents one row of five equal platform tiles', () => {
  assert.equal(html.match(/data-platform="(?:ios|android|macos|windows|linux)"/g)?.length, 5);
  for (const platform of ['ios', 'android', 'macos', 'windows', 'linux']) {
    assert.match(html, new RegExp(`data-platform="${platform}"`));
  }
  assert.match(html, /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(html, /data-platform="ios"[\s\S]*?<span>App Store<\/span>/);
  assert.match(html, /data-platform="android"[\s\S]*?<span>Google Play<\/span>/);
  assert.doesNotMatch(html, /store-badge|assets\/store-badges/);
});

test('platform detection prioritizes phones before desktop user-agent fragments', () => {
  assert.equal(
    selectPlatform({
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile',
      platform: 'Linux armv8l',
    }),
    'android',
  );
  assert.equal(
    selectPlatform({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    }),
    'ios',
  );
  assert.equal(selectPlatform({ userAgent: 'ExampleBrowser/1.0', platform: '' }), undefined);
});

test('landing page names the browser option once and removes the split download UI', () => {
  assert.equal(html.match(/open Beeline in the browser/g)?.length, 1);
  assert.match(html, /href="https:\/\/web\.usebeeline\.app"/);
  for (const removed of [
    'Download for Linux',
    'Other platforms',
    'Desktop · macOS universal · Windows and Linux x86_64',
  ]) {
    assert.doesNotMatch(html, new RegExp(removed));
  }
  assert.doesNotMatch(html, /class="stores"|class="store"/);
});

test('landing hero links the launch video and permanent community invite without a private-repo footer link', () => {
  assert.match(html, /href="https:\/\/youtu\.be\/i2sHELZVlWM"[^>]*>▶ Watch the launch video<\/a>/);
  assert.match(html, /href="https:\/\/usebeeline\.app\/join\/inv_8765f41a655c33815ea86cecf199ab60983b9326bb02b869f6436af1286dd0f2">Join the Beeline Community<\/a>/);
  const footer = html.match(/<footer>([\s\S]*?)<\/footer>/)[1];
  assert.doesNotMatch(footer, /github\.com\/Beeline-Work\/beeline/);
  assert.doesNotMatch(html, /community-link-pending/);
});

test('terms page carries the beeline brand tokens and links home', () => {
  assert.match(termsHtml, /<title>Beeline Terms<\/title>/);
  assert.match(termsHtml, /--brass:#d7af5f/);
});

 test('support community link matches the permanent public invite seeded by migration', () => {
  const token = html.match(/href="https:\/\/usebeeline.app\/join\/(inv_[0-9a-f]{64})">Join Beeline Community/)?.[1];
  assert.ok(token);
  const schema = fs.readFileSync(path.join(ROOT, 'apps/server/src/database.ts'), 'utf8');
  assert.ok(schema.includes(token));
  assert.ok(schema.includes('8556a9be-d929-41e7-a0ef-d70af452a494'));
});
