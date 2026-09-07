import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPagesSite, verifyPagesOrigin } from './pages-site.mjs';

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
    version: 'v0.0.58',
    bundles: {
      'linux-x64': {
        file: filename,
        sha256: digest,
        bytes: archive.byteLength,
        node: '>=20.11.0',
        commit: SHA,
        version: 'v0.0.58',
        verified: true,
      },
    },
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, filename), archive);
  fs.writeFileSync(path.join(root, `${filename}.sha256`), `${digest}  ${filename}\n`);
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { archive, filename, manifest };
}

test('builds the exact Pages paths from repository static files and a verified daemon artifact', async () => {
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
    assert.deepEqual(
      fs.readFileSync(path.join(outputRoot, '.well-known', 'apple-app-site-association')),
      fs.readFileSync(path.join(WEB_ROOT, '.well-known', 'apple-app-site-association')),
    );
    assert.deepEqual(
      fs.readFileSync(path.join(outputRoot, '.well-known', 'assetlinks.json')),
      fs.readFileSync(path.join(WEB_ROOT, '.well-known', 'assetlinks.json')),
    );
    assert.deepEqual(
      fs.readFileSync(path.join(outputRoot, 'install')),
      fs.readFileSync(path.join(WEB_ROOT, 'install.sh')),
    );
    assert.deepEqual(
      fs.readFileSync(path.join(outputRoot, 'dl', fixture.filename)),
      fixture.archive,
    );
    assert.equal(fs.existsSync(path.join(outputRoot, '.well-known', 'nostr.json')), false);
    assert.equal(fs.readFileSync(path.join(outputRoot, 'CNAME'), 'utf8'), 'usebeeline.app\n');
    assert.match(fs.readFileSync(path.join(outputRoot, '404.html'), 'utf8'), /\/join\/index\.html/);
    assert.match(
      fs.readFileSync(path.join(outputRoot, '404.html'), 'utf8'),
      /\/review\/index\.html/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('remote verification rejects redirects and proves every public byte including the absent Nostr route', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-pages.'));
  const bundleRoot = path.join(temporary, 'bundle');
  const fixture = fixtureBundle(bundleRoot);
  const responses = new Map([
    [
      '/.well-known/apple-app-site-association',
      fs.readFileSync(path.join(WEB_ROOT, '.well-known', 'apple-app-site-association')),
    ],
    [
      '/.well-known/assetlinks.json',
      fs.readFileSync(path.join(WEB_ROOT, '.well-known', 'assetlinks.json')),
    ],
    ['/install', fs.readFileSync(path.join(WEB_ROOT, 'install.sh'))],
    ['/dl/manifest.json', fs.readFileSync(path.join(bundleRoot, 'manifest.json'))],
    [`/dl/${fixture.filename}`, fixture.archive],
    [
      `/dl/${fixture.filename}.sha256`,
      fs.readFileSync(path.join(bundleRoot, `${fixture.filename}.sha256`)),
    ],
  ]);
  const fetchImpl = async (url, init = {}) => {
    assert.equal(init.redirect, 'manual');
    const pathname = new URL(url).pathname;
    if (pathname === '/.well-known/nostr.json') return new Response('not found', { status: 404 });
    const body = responses.get(pathname);
    return body ? new Response(body, { status: 200 }) : new Response('not found', { status: 404 });
  };
  try {
    await verifyPagesOrigin({
      origin: 'https://usebeeline.app',
      sourceRoot: WEB_ROOT,
      bundleRoot,
      fetchImpl,
    });
    const redirectingFetch = async (url, init) => {
      if (new URL(url).pathname === '/.well-known/apple-app-site-association') {
        return new Response(null, { status: 302, headers: { location: '/elsewhere' } });
      }
      return fetchImpl(url, init);
    };
    await assert.rejects(
      verifyPagesOrigin({
        origin: 'https://usebeeline.app',
        sourceRoot: WEB_ROOT,
        bundleRoot,
        fetchImpl: redirectingFetch,
      }),
      /returned HTTP 302; expected 200 without a redirect/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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

test('refuses a corrupt bundle before producing a Pages tree', async () => {
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

test('publishes Pages on main and keeps release promotion behind an exact public-byte proof', () => {
  const pagesWorkflow = fs.readFileSync(
    path.join(REPOSITORY_ROOT, '.github', 'workflows', 'pages.yml'),
    'utf8',
  );
  const pagesAction = fs.readFileSync(
    path.join(REPOSITORY_ROOT, '.github', 'actions', 'pages-site', 'action.yml'),
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
  assert.match(pagesWorkflow, /status: 'success'/);
  assert.match(pagesWorkflow, /actions\/configure-pages@v5/);
  assert.match(pagesWorkflow, /actions\/deploy-pages@v4/);
  assert.match(pagesWorkflow, /pages-site\.mjs verify/);
  assert.match(pagesAction, /actions\/upload-pages-artifact@v5/);
  assert.match(pagesAction, /include-hidden-files: true/);
  assert.ok(
    unifiedRelease.indexOf('\n  publish_pages:') < unifiedRelease.indexOf('\n  promote_daemon:'),
  );
  assert.match(daemonLeg, /pages-site\.mjs verify/);
  assert.doesNotMatch(daemonLeg, /buzz-router-relay-prod|publish-beeline-dl/);
});
