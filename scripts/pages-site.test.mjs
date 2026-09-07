import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPagesSite } from './pages-site.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const WEB_ROOT = path.join(REPOSITORY_ROOT, 'relay-stack', 'web');
const SHA = 'a'.repeat(40);

function fixtureBundle(root) {
  const archive = Buffer.from('verified linux bundle');
  const digest = createHash('sha256').update(archive).digest('hex');
  const filename = 'beeline-linux-x64.tar.gz';
  const manifest = {
    schemaVersion: 1,
    sourceCommit: SHA,
    version: '0.0.1',
    bundles: {
      'linux-x64': {
        file: filename,
        sha256: digest,
        bytes: archive.byteLength,
        node: '>=20.11.0',
        commit: SHA,
        version: '0.0.1',
        verified: true,
      },
    },
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, filename), archive);
  fs.writeFileSync(path.join(root, `${filename}.sha256`), `${digest}  ${filename}\n`);
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { archive, filename };
}

test('builds every public Pages path and preserves association and helper bytes', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-pages.'));
  const bundleRoot = path.join(temporary, 'bundle');
  const outputRoot = path.join(temporary, 'site');
  const fixture = fixtureBundle(bundleRoot);
  try {
    await buildPagesSite({ sourceRoot: WEB_ROOT, bundleRoot, outputRoot });

    for (const file of [
      'index.html',
      'privacy/index.html',
      'terms/index.html',
      'brand/index.html',
      'review/index.html',
      'join/index.html',
      '404.html',
      'CNAME',
      '.nojekyll',
      '.well-known/apple-app-site-association',
      '.well-known/assetlinks.json',
      'install',
      'dl/manifest.json',
      `dl/${fixture.filename}`,
      `dl/${fixture.filename}.sha256`,
    ]) {
      assert.equal(fs.statSync(path.join(outputRoot, file)).isFile(), true, file);
    }
    for (const file of ['apple-app-site-association', 'assetlinks.json']) {
      assert.deepEqual(
        fs.readFileSync(path.join(outputRoot, '.well-known', file)),
        fs.readFileSync(path.join(WEB_ROOT, '.well-known', file)),
      );
    }
    assert.deepEqual(
      fs.readFileSync(path.join(outputRoot, 'dl', 'manifest.json')),
      fs.readFileSync(path.join(bundleRoot, 'manifest.json')),
    );
    assert.deepEqual(
      fs.readFileSync(path.join(outputRoot, 'dl', fixture.filename)),
      fixture.archive,
    );
    assert.equal(fs.readFileSync(path.join(outputRoot, 'CNAME'), 'utf8'), 'usebeeline.app\n');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('refuses a corrupt helper bundle before producing a Pages tree', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-pages.'));
  const bundleRoot = path.join(temporary, 'bundle');
  const outputRoot = path.join(temporary, 'site');
  const fixture = fixtureBundle(bundleRoot);
  fs.appendFileSync(path.join(bundleRoot, fixture.filename), 'corrupt');
  try {
    await assert.rejects(
      buildPagesSite({ sourceRoot: WEB_ROOT, bundleRoot, outputRoot }),
      /does not match its sha256/,
    );
    assert.equal(fs.existsSync(outputRoot), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('the Pages workflow is standalone and the release keeps its dev-host publisher', () => {
  const pagesWorkflow = fs.readFileSync(
    path.join(REPOSITORY_ROOT, '.github', 'workflows', 'pages.yml'),
    'utf8',
  );
  const unifiedRelease = fs.readFileSync(
    path.join(REPOSITORY_ROOT, '.github', 'workflows', 'unified-release.yml'),
    'utf8',
  );
  const daemonLeg = fs.readFileSync(
    path.join(REPOSITORY_ROOT, '.github', 'actions', 'daemon-leg', 'action.yml'),
    'utf8',
  );

  assert.match(pagesWorkflow, /^on:\s*\n\s*push:\s*\n\s*branches: \[main\]/m);
  assert.match(pagesWorkflow, /workflow_dispatch: \{\}/);
  assert.match(pagesWorkflow, /pages-site\.mjs build/);
  assert.match(pagesWorkflow, /actions\/upload-pages-artifact@v5/);
  assert.match(pagesWorkflow, /include-hidden-files: true/);
  assert.match(pagesWorkflow, /actions\/deploy-pages@v4/);
  assert.doesNotMatch(pagesWorkflow, /unified-release/);
  assert.doesNotMatch(unifiedRelease, /publish_pages|pages_artifact|pages-site/);
  assert.match(daemonLeg, /scripts\/publish-beeline-dl\.mjs/);
  assert.match(daemonLeg, /\/home\/lunchbox\/buzz-router-relay-prod\/relay-front\/web\/dl/);
});

test('the Pages 404 router preserves dynamic join and review fallback URLs', async () => {
  const page = fs.readFileSync(path.join(WEB_ROOT, '404.html'), 'utf8');
  const script = page.match(/<script>\n([\s\S]*?)\n    <\/script>/)?.[1];
  assert.ok(script);

  for (const [pathname, expectedTemplate] of [
    ['/join/inv_abc', '/join/index.html'],
    ['/review/reviewer-secret', '/review/index.html'],
  ]) {
    let written = '';
    const status = { textContent: '', innerHTML: '' };
    const fetches = [];
    const priorWindow = globalThis.window;
    const priorDocument = globalThis.document;
    const priorFetch = globalThis.fetch;
    globalThis.window = { location: { pathname } };
    globalThis.document = {
      querySelector: () => status,
      open: () => undefined,
      write: (html) => {
        written = html;
      },
      close: () => undefined,
    };
    globalThis.fetch = async (url) => {
      fetches.push(url);
      return new Response(`<main>${expectedTemplate}</main>`);
    };
    try {
      Function(script)();
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      assert.deepEqual(fetches, [expectedTemplate]);
      assert.equal(written, `<main>${expectedTemplate}</main>`);
    } finally {
      globalThis.window = priorWindow;
      globalThis.document = priorDocument;
      globalThis.fetch = priorFetch;
    }
  }
});
