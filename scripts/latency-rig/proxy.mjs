#!/usr/bin/env node
/** Local-only shaped HTTP/WebSocket reverse proxy with one NDJSON record per exchange. */
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { PHONE_READ_OPERATIONS } from '@beeline/api-contract/phone';
import { messageSchedule } from './message-shaping.mjs';
import socketMarks from './socket-marks.cjs';

const { phoneFrame, socketRequestTrace } = socketMarks;
const readOperations = new Set(PHONE_READ_OPERATIONS);

const backend = new URL(process.env.LATENCY_RIG_BACKEND ?? 'http://127.0.0.1:8080');
const listenPort = Number(process.env.LATENCY_RIG_PORT ?? 8081);
let rttMs = Number(process.env.LATENCY_RIG_RTT_MS ?? 100);
let jitterMs = Number(process.env.LATENCY_RIG_JITTER_MS ?? 0);
let mbps = Number(process.env.LATENCY_RIG_MBPS ?? 10);
let failureRate = Number(process.env.LATENCY_RIG_REQUEST_FAILURE_RATE ?? 0);
const output = process.env.LATENCY_RIG_PROXY_LOG;
if (!['127.0.0.1', 'localhost', '::1'].includes(backend.hostname) ||
    !['http:', 'https:'].includes(backend.protocol) ||
    !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535 ||
    !Number.isFinite(rttMs) || rttMs < 0 || !Number.isFinite(jitterMs) || jitterMs < 0 ||
    !Number.isFinite(mbps) || mbps <= 0 || failureRate < 0 || failureRate > 1)
  throw new Error('Invalid local proxy settings');
if (!output) throw new Error('LATENCY_RIG_PROXY_LOG is required');

const log = createWriteStream(output, { flags: 'a', mode: 0o600 });
const emit = (record) => { log.write(`${JSON.stringify(record)}\n`); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const halfRtt = () => Math.max(0, rttMs / 2 + (Math.random() * 2 - 1) * jitterMs / 2);
const bytesDelay = (bytes) => bytes * 8 / (mbps * 1_000_000) * 1000;
const client = backend.protocol === 'https:' ? httpsRequest : httpRequest;
const socketTarget = `${backend.protocol === 'https:' ? 'wss:' : 'ws:'}//${backend.host}`;

function shapedStream(onBytes) {
  let queue = Promise.resolve();
  return new Transform({
    transform(chunk, _encoding, callback) {
      onBytes(chunk.length);
      queue = queue.then(() => delay(bytesDelay(chunk.length)));
      queue.then(() => callback(null, chunk), callback);
    },
  });
}

const handler = async (incoming, outgoing) => {
  if (incoming.url === '/__latency-rig/profile' && incoming.method === 'POST') {
    let raw = '';
    for await (const chunk of incoming) {
      raw += chunk;
      if (raw.length > 1024) { outgoing.writeHead(413).end(); return; }
    }
    let profile;
    try { profile = JSON.parse(raw); } catch { outgoing.writeHead(400).end(); return; }
    if (!profile || typeof profile !== 'object' ||
        !Number.isFinite(profile.rttMs) || profile.rttMs < 0 ||
        !Number.isFinite(profile.jitterMs) || profile.jitterMs < 0 ||
        !Number.isFinite(profile.mbps) || profile.mbps <= 0 ||
        !Number.isFinite(profile.failureRate) || profile.failureRate < 0 || profile.failureRate > 1) {
      outgoing.writeHead(400).end(); return;
    }
    ({ rttMs, jitterMs, mbps, failureRate } = profile);
    emit({ type: 'profile', atMs: Date.now(), ...profile });
    outgoing.writeHead(204).end();
    return;
  }
  const startMs = Date.now();
  const operation = incoming.url;
  const traceId = randomUUID();
  let requestBytes = 0;
  let responseBytes = 0;
  if (Math.random() < failureRate) {
    await delay(halfRtt());
    outgoing.writeHead(503).end();
    emit({ type: 'http', traceId, startMs, endMs: Date.now(), operation, status: 503,
      requestBytes, responseBytes, injectedFailure: true });
    return;
  }
  await delay(halfRtt());
  const headers = { ...incoming.headers, host: backend.host,
    'x-latency-rig-trace': traceId };
  delete headers.connection;
  const upstream = client(new URL(incoming.url, backend), { method: incoming.method, headers }, async (response) => {
    await delay(halfRtt());
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(shapedStream((bytes) => { responseBytes += bytes; })).pipe(outgoing);
    outgoing.once('finish', () => emit({ type: 'http', traceId, startMs, endMs: Date.now(),
      operation, method: incoming.method, status: response.statusCode,
      requestBytes, responseBytes }));
  });
  incoming.pipe(shapedStream((bytes) => { requestBytes += bytes; })).pipe(upstream);
  upstream.once('error', (error) => {
    if (!outgoing.headersSent) outgoing.writeHead(502).end();
    emit({ type: 'http', traceId, startMs, endMs: Date.now(), operation, method: incoming.method,
      status: 502, requestBytes, responseBytes, error: error.message });
  });
};

const tlsCertificate = process.env.LATENCY_RIG_TLS_CERT;
const tlsKey = process.env.LATENCY_RIG_TLS_KEY;
if (Boolean(tlsCertificate) !== Boolean(tlsKey)) throw new Error('TLS_CERT and TLS_KEY must be supplied together');
const server = tlsCertificate
  ? createHttpsServer({ cert: await readFile(tlsCertificate), key: await readFile(tlsKey) }, handler)
  : createHttpServer(handler);
const websocketServer = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  websocketServer.handleUpgrade(request, socket, head, (downstream) => {
    const startedMs = Date.now();
    const traceId = randomUUID();
    const pending = [];
    const requests = new Map();
    let upQueue = Promise.resolve();
    let downQueue = Promise.resolve();
    const scheduleUp = messageSchedule();
    const scheduleDown = messageSchedule();
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '')
      .split(',').map((value) => value.trim()).filter(Boolean);
    const upstream = new WebSocket(`${socketTarget}${request.url}`, protocols, {
      headers: { authorization: request.headers.authorization ?? '',
        'x-latency-rig-trace': traceId },
    });
    const relayUp = async (data, isBinary, startMs, dueAt) => {
      await delay(dueAt - Date.now());
      if (upstream.readyState !== WebSocket.OPEN) return;
      upstream.send(data, { binary: isBinary });
      emit({ type: 'ws', traceId, granularity: 'message', direction: 'up', startMs, endMs: Date.now(), bytes: data.length,
        connectionStartMs: startedMs });
    };
    const enqueueUp = (data, isBinary, startMs) => {
      const dueAt = scheduleUp(startMs, halfRtt(), bytesDelay(data.length));
      upQueue = upQueue.then(() => relayUp(data, isBinary, startMs, dueAt));
    };
    downstream.on('message', (data, isBinary) => {
      const startMs = Date.now();
      const frame = phoneFrame(data, isBinary);
      if (frame?.t === 'req') {
        const duplicate = requests.has(frame.id);
        const span = { type: 'phone-request', traceId: duplicate ? randomUUID() : socketRequestTrace(traceId, frame.id),
          connectionTraceId: traceId, operation: `phone.${frame.op}`,
          method: readOperations.has(frame.op) ? 'GET' : 'POST', startMs, requestBytes: data.length,
          ...(duplicate ? { invalid: true } : {}) };
        emit({ ...span, phase: 'start' });
        if (!duplicate) requests.set(frame.id, span);
      }
      if (upstream.readyState === WebSocket.OPEN) enqueueUp(data, isBinary, startMs);
      else pending.push([data, isBinary, startMs]);
    });
    upstream.on('open', () => {
      for (const [data, isBinary, startMs] of pending) enqueueUp(data, isBinary, startMs);
      pending.length = 0;
      upstream.on('message', (data, isBinary) => {
        const startMs = Date.now();
        const frame = phoneFrame(data, isBinary);
        const dueAt = scheduleDown(startMs, halfRtt(), bytesDelay(data.length));
        downQueue = downQueue.then(async () => {
          await delay(dueAt - Date.now());
          if (downstream.readyState !== WebSocket.OPEN) return;
          downstream.send(data, { binary: isBinary });
          const endMs = Date.now();
          emit({ type: 'ws', traceId, granularity: 'message', direction: 'down', startMs, endMs, bytes: data.length,
            connectionStartMs: startedMs });
          if (frame?.t === 'res' && requests.has(frame.id)) {
            emit({ ...requests.get(frame.id), phase: 'end', endMs, responseBytes: data.length,
              complete: true, ok: frame.ok });
            requests.delete(frame.id);
          }
        });
      });
    });
    upstream.on('close', () => downstream.close());
    downstream.on('close', () => upstream.terminate());
    upstream.on('error', () => downstream.close());
  });
});

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`Latency rig proxy on :${listenPort} to ${backend.origin}; RTT=${rttMs} ms jitter=${jitterMs} ms bandwidth=${mbps} Mbps`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => log.end(() => process.exit()));
});
