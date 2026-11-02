import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { summarize, summarizeSample } from './analyze.mjs';
import { compareNightly } from './nightly-compare.mjs';

const tap = (phone) => ({ kind: 'tap', name: 'react-message', variant: 'warm',
  clockDomain: 'host', startMs: 0, paintMs: 30, endMs: 250, phone });
const request = (operation, method, startMs = 10, endMs = 110) => ({
  operation: `phone.${operation}`, method, startMs, endMs, complete: true, ok: true,
});

test('socket writes satisfy the same optimistic request contract as HTTP writes', () => {
  const sample = tap([request('reactToMessage', 'POST')]);
  assert.equal(summarizeSample(sample).writeCount, 1);
  assert.equal(summarize([sample]).requestPass, true);
  assert.equal(summarize([{ ...sample, paintMs: 120 }]).requestPass, false);
  assert.equal(summarize([tap([...sample.phone, request('readRoom', 'GET', 111, 140)])]).requestPass, false);
  assert.equal(summarize([tap([{ ...sample.phone[0], complete: false }])]).requestPass, false);
  assert.equal(summarize([tap([{ ...sample.phone[0], ok: false }])]).requestPass, false);
});

test('socket reads cannot bypass warm, optional, or mixed-transport request budgets', () => {
  const sample = { kind: 'route', name: '/beeline/chat/[channelId]', variant: 'warm',
    clockDomain: 'host', startMs: 0, paintMs: 100, endMs: 250,
    phone: [request('readRoom', 'GET')] };
  assert.equal(summarize([sample]).requestPass, false);
  const routes = [{ path: sample.name, variants: ['cold'], coldHttpMax: 1, coldDepthMax: 1 }];
  for (const operation of ['readStarPrompt', 'readWorkspace', 'readChats', 'markRead', 'reportPageLoad']) {
    const optional = { ...sample, variant: 'cold', phone: [request(operation, 'GET')] };
    assert.equal(summarize([optional], routes).requestPass, false, operation);
    const afterPaint = { ...optional, phone: [{ ...optional.phone[0], startMs: 101, complete: false }] };
    assert.equal(summarize([afterPaint], routes).requestPass, true, `${operation} remains outside the prepaint budget`);
  }
  const mixed = { ...sample, variant: 'cold', phone: [request('readRoom', 'GET', 60, 110)],
    http: [{ method: 'GET', operation: '/covering-read', startMs: 10, endMs: 50 }] };
  const row = summarize([mixed], routes).rows[0];
  assert.equal(row.maxPrepaintHttpCount, 1);
  assert.equal(row.maxPrepaintRequestCount, 2);
  assert.equal(row.maxPrepaintRequestDepth, 2);
  assert.equal(row.requestPass, false);
});

test('a request-contract failure below the timing budget is reported accurately', () => {
  const verdict = compareNightly({ complete: true, clockCalibrated: true, maxClockUncertaintyMs: 8,
    rows: [{ kind: 'tap', name: 'react-message', variant: 'warm', samples: 20,
      p95Ms: 119, budgetMs: 150, timingPass: true, requestPass: false }] }, null);
  assert.equal(verdict.pass, false);
  assert.ok(verdict.failures.some(value => /request contract/i.test(value)));
  assert.ok(verdict.failures.every(value => !/budget exceeded/i.test(value)));
});

test('real socket requests retain request/reply and SQL identity without logging payloads', async () => {
  const root = fileURLToPath(new URL('./.local/', import.meta.url));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'socket-proof-'));
  const sqlPath = join(directory, 'sql.ndjson');
  const proxyPath = join(directory, 'proxy.ndjson');
  const probe = fileURLToPath(new URL('./pg-probe.cjs', import.meta.url));
  const backend = spawn(process.execPath, ['--input-type=commonjs', '-e', `
    const pg = require('pg');
    pg.Client.prototype.query = async () => ({ rowCount: 1 });
    require(${JSON.stringify(probe)});
    const http = require('node:http');
    const { WebSocketServer } = require('ws');
    const server = http.createServer();
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => sockets.handleUpgrade(request, socket, head, peer => peer.on('message', async data => {
      const frame = JSON.parse(String(data));
      if (frame.t !== 'req' || frame.op === 'readHistory') return;
      await new Promise(resolve => setTimeout(resolve, frame.op === 'readRoom' ? 1 : 25));
      await new pg.Client().query('not sent to a database');
      peer.send(JSON.stringify({ t: 'res', id: frame.id, ok: true, result: { secret: 'response-secret'.repeat(6000) } }));
    })));
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: 'postgresql://localhost/latency_rig_socket_test',
    LATENCY_RIG_SQL_LOG: sqlPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let proxy;
  let socket;
  let deadline;
  try {
    const [ready] = await once(backend.stdout, 'data');
    const reserve = createServer();
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    proxy = spawn(process.execPath, [fileURLToPath(new URL('./proxy.mjs', import.meta.url))], {
      env: { ...process.env, LATENCY_RIG_BACKEND: `http://127.0.0.1:${Number(String(ready).trim())}`,
        LATENCY_RIG_PORT: String(port), LATENCY_RIG_RTT_MS: '0', LATENCY_RIG_JITTER_MS: '0',
        LATENCY_RIG_MBPS: '10', LATENCY_RIG_REQUEST_FAILURE_RATE: '0', LATENCY_RIG_PROXY_LOG: proxyPath,
        LATENCY_RIG_TLS_CERT: '', LATENCY_RIG_TLS_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await once(proxy.stdout, 'data');
    socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`);
    await once(socket, 'open');
    const startMs = Date.now();
    const replies = [];
    const complete = new Promise((resolve, reject) => {
      socket.on('message', data => { replies.push(JSON.parse(String(data))); if (replies.length === 2) resolve(); });
      socket.on('error', reject);
      deadline = setTimeout(() => reject(new Error('Socket fixture did not reply')), 5000);
    });
    for (const [id, op] of [['request-secret-write', 'reactToMessage'], ['request-secret-read', 'readRoom'],
      ['request-secret-unfinished', 'readHistory']]) {
      socket.send(JSON.stringify({ t: 'req', id, op, args: { secret: 'request-payload-secret' } }));
    }
    await complete;
    clearTimeout(deadline);
    assert.equal(replies[0].id, 'request-secret-read');
    // Receiving replies does not mean the proxy's asynchronous log stream flushed.
    // Count only complete records while waiting for both request completions.
    let logged;
    const logDeadline = Date.now() + 5000;
    for (;;) {
      logged = await readFile(proxyPath, 'utf8');
      const completed = logged.split('\n').slice(0, -1).map(JSON.parse)
        .filter(span => span.type === 'phone-request' && span.phase === 'end');
      if (completed.length === 2) break;
      assert.ok(Date.now() < logDeadline, 'Proxy did not persist both reply spans');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const endMs = Date.now();
    assert.ok(!/request-secret|request-payload-secret|response-secret/.test(logged));
    const records = logged.trim().split('\n').map(JSON.parse);
    const starts = records.filter(span => span.type === 'phone-request' && span.phase === 'start');
    const ends = records.filter(span => span.type === 'phone-request' && span.phase === 'end');
    assert.equal(starts.length, 3);
    assert.equal(ends.length, 2);
    assert.deepEqual(ends.map(span => span.operation), ['phone.readRoom', 'phone.reactToMessage']);
    assert.equal(starts.find(span => span.operation === 'phone.readRoom').method, 'GET');
    assert.equal(starts.find(span => span.operation === 'phone.reactToMessage').method, 'POST');
    const sql = (await readFile(sqlPath, 'utf8')).trim().split('\n').map(JSON.parse).filter(span => span.type === 'sql');
    assert.equal(sql.length, 2);
    for (const span of sql) assert.equal(span.traceId, starts.find(request => request.operation === span.operation)?.traceId);
    const momentPath = join(directory, 'moments.ndjson');
    const output = join(directory, 'samples.ndjson');
    await writeFile(momentPath, JSON.stringify({ kind: 'route', name: 'room', variant: 'cold',
      clockDomain: 'host', startMs, paintMs: endMs - 1, endMs }) + '\n');
    execFileSync(process.execPath, [fileURLToPath(new URL('./join.mjs', import.meta.url)), '--moments', momentPath,
      '--proxy', proxyPath, '--sql', sqlPath, '--out', output]);
    const joined = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(joined.phone.length, 3);
    assert.equal(joined.phone.filter(span => span.complete === false).length, 1);
    assert.equal(joined.sql.length, 2);
    const summary = summarizeSample(joined);
    assert.equal(summary.writeCount, 1);
    assert.equal(summary.prepaintRequestCount, 3);
    assert.equal(summary.wsMessages, 5);
    assert.equal(summarize([joined]).requestPass, false);
  } finally {
    clearTimeout(deadline);
    socket?.terminate();
    if (proxy) { proxy.kill('SIGKILL'); await once(proxy, 'close'); }
    backend.kill('SIGKILL');
    await once(backend, 'close');
    await rm(directory, { recursive: true, force: true });
  }
});
