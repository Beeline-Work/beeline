import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

test('the proxy delivers a subscription burst without charging an RTT per message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rig-proxy-'));
  const backend = createServer();
  const upstream = new WebSocketServer({ server: backend });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  upstream.on('connection', (peer) => peer.once('message', () => {
    for (let index = 0; index < 100; index++) peer.send(String(index).padStart(3, '0') + 'x'.repeat(139));
  }));
  const proxy = spawn(process.execPath, [fileURLToPath(new URL('./proxy.mjs', import.meta.url))], {
    env: { ...process.env, LATENCY_RIG_BACKEND: `http://127.0.0.1:${backend.address().port}`,
      LATENCY_RIG_PORT: String(port), LATENCY_RIG_RTT_MS: '100', LATENCY_RIG_JITTER_MS: '0',
      LATENCY_RIG_MBPS: '10', LATENCY_RIG_REQUEST_FAILURE_RATE: '0',
      LATENCY_RIG_PROXY_LOG: join(directory, 'proxy.ndjson'),
      LATENCY_RIG_TLS_CERT: '', LATENCY_RIG_TLS_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let client;
  let timeout;
  try {
    await once(proxy.stdout, 'data');
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(client, 'open');
    const received = [];
    const all = new Promise((resolve, reject) => {
      client.on('message', (data) => {
        received.push(Number(String(data).slice(0, 3)));
        if (received.length === 100) resolve();
      });
      client.on('error', reject);
    });
    const started = performance.now();
    client.send('start');
    await Promise.race([all, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Subscription burst remained queued for 1.5 seconds')), 1500);
    })]);
    assert.ok(performance.now() - started < 1500);
    assert.deepEqual(received, Array.from({ length: 100 }, (_, index) => index));
  } finally {
    clearTimeout(timeout);
    client?.terminate();
    proxy.kill('SIGKILL');
    await once(proxy, 'close');
    for (const peer of upstream.clients) peer.terminate();
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => backend.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
