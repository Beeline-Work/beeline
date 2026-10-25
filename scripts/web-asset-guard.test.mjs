import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../infra/web-assets/worker.mjs';

const asset = 'https://web.usebeeline.app/_expo/static/js/web/native-crash-reporting-deadbeef.js';

test('BEELINE-MOBILE-9: HTML fallback becomes an uncached plain 404 for GET and HEAD', async (t) => {
  for (const method of ['GET', 'HEAD']) {
    const request = new Request(asset + '?v=old', { method });
    const origin = new Response(method === 'HEAD' ? null : '<!doctype html><title>Beeline</title>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'ETag': 'shell', 'Cache-Control': 'max-age=3600' },
    });
    const mock = t.mock.method(globalThis, 'fetch', async (input) => {
      assert.equal(input, request);
      return origin;
    });
    const response = await worker.fetch(request);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('etag'), null);
    assert.equal(await response.text(), method === 'HEAD' ? '' : 'JavaScript asset not found\n');
    mock.mock.restore();
  }
});

test('existing chunks, conditional requests, origin failures and navigation pass through intact', async (t) => {
  for (const [url, status, type, method] of [
    [asset, 200, 'application/javascript', 'GET'],
    [asset, 304, null, 'GET'],
    [asset, 503, 'text/plain', 'GET'],
    [asset, 503, 'text/html', 'GET'],
    [asset, 404, 'text/plain', 'GET'],
    ['https://web.usebeeline.app/beeline/chat/room', 200, 'text/html', 'GET'],
    ['https://web.usebeeline.app/assets/picture.svg', 200, 'image/svg+xml', 'GET'],
    [asset, 200, 'text/html', 'POST'],
  ]) {
    const origin = new Response(null, { status, headers: type ? { 'Content-Type': type } : {} });
    const mock = t.mock.method(globalThis, 'fetch', async () => origin);
    assert.equal(await worker.fetch(new Request(url, { method })), origin);
    mock.mock.restore();
  }
});

test('retains requested immutable chunks across a deployment without caching the HTML fallback', async (t) => {
  const retained = new Map();
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  t.after(() => {
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
    else delete globalThis.caches;
  });
  globalThis.caches = { default: {
    match: async (key) => retained.get(key.url)?.clone(),
    put: async (key, value) => { retained.set(key.url, value); },
  } };
  let deployed = false;
  let originReads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    originReads++;
    return new Response(deployed ? '<!doctype html>' : 'window.oldFeature = true;', {
      headers: { 'Content-Type': deployed ? 'text/html' : 'application/javascript' },
    });
  });
  const pending = [];
  const context = { waitUntil: (promise) => pending.push(promise) };
  const request = new Request(asset.replace('deadbeef', '0123456789abcdef0123456789abcdef'));
  await worker.fetch(request, {}, context);
  await Promise.all(pending);
  deployed = true;
  const oldChunk = await worker.fetch(request, {}, context);
  assert.equal(await oldChunk.text(), 'window.oldFeature = true;');
  assert.equal(originReads, 1);
  const missing = await worker.fetch(new Request(request.url.replace('01234567', '12345678')), {}, context);
  assert.equal(missing.status, 404);
  assert.equal(retained.size, 1);
});
