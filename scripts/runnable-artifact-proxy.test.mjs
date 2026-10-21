import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGameProxy } from './runnable-artifact-proxy.mjs';

test('game proxy carries no sessions, strips cookies, and fails closed without CSP', async () => {
  const calls = [];
  let sandbox = true;
  const backend = createServer((req, res) => {
    calls.push(req.headers);
    res.writeHead(200, {
      'content-type': 'text/html',
      ...(sandbox
        ? { 'content-security-policy': "default-src 'none'; sandbox allow-scripts" }
        : {}),
      'set-cookie': 'unexpected=secret',
    });
    res.end('<script>game()</script>');
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const proxy = createGameProxy({ upstream: `http://127.0.0.1:${backend.address().port}` });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${proxy.address().port}`;
    const path = '/play/11111111-1111-4111-8111-111111111111?token=opaque';
    const result = await fetch(base + path, {
      headers: { authorization: 'Bearer private', cookie: 'session=private' },
    });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), '<script>game()</script>');
    assert.equal(result.headers.get('set-cookie'), null);
    assert.equal(calls[0].host, 'beeline-games.fly.dev');
    assert.equal(calls[0].authorization, undefined);
    assert.equal(calls[0].cookie, undefined);
    assert.equal((await fetch(base + '/v1/phone/identity')).status, 404);
    assert.equal(calls.length, 1);
    sandbox = false;
    assert.equal((await fetch(base + path)).status, 503);
  } finally {
    await Promise.all(
      [backend, proxy].map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }
});
