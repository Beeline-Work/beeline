/* Local server preload: request-scoped SQL, pool wait, and finish spans.
 * NODE_OPTIONS='--require ./scripts/latency-rig/pg-probe.cjs' npm run dev -w @beeline/server
 */
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { syncBuiltinESMExports } = require('node:module');
const pg = require('pg');

const output = process.env.LATENCY_RIG_SQL_LOG;
const databaseUrl = process.env.DATABASE_URL;
if (!output || !databaseUrl) throw new Error('LATENCY_RIG_SQL_LOG and DATABASE_URL are required');
const target = new URL(databaseUrl);
if (process.env.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1', '::1'].includes(target.hostname) ||
    (target.searchParams.has('host') &&
      target.searchParams.get('host') !== '/var/run/postgresql') ||
    !/latency_rig/.test(target.pathname))
  throw new Error('SQL probe refuses production or a non-local latency_rig database');
const fd = fs.openSync(output, 'a', 0o600);
const context = new AsyncLocalStorage();
const waits = new WeakMap();
let nextTrace = 0;
const emit = (record) => fs.writeSync(fd, `${JSON.stringify(record)}\n`);

function operationName(url) {
  const pathname = new URL(url ?? '/', 'http://localhost').pathname;
  const named = /^\/v1\/phone\/operations\/([^/]+)/.exec(pathname);
  if (named) return `phone.${named[1]}`;
  if (/^\/v1\/phone\/rooms\//.test(pathname)) return 'phone.read_room';
  if (/^\/v1\/phone\/live/.test(pathname)) return 'phone.live';
  return pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id');
}

const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event !== 'request' && event !== 'upgrade') return originalEmit.call(this, event, ...args);
  const request = args[0];
  const response = args[1];
  const incomingTrace = request.headers['x-latency-rig-trace'];
  const traceId = typeof incomingTrace === 'string' && /^[0-9a-f-]{36}$/.test(incomingTrace)
    ? incomingTrace : ++nextTrace;
  const scope = { traceId, operation: operationName(request.url), startMs: Date.now() };
  return context.run(scope, () => {
    if (event === 'request') response.once('finish', () => emit({ type: 'operation', ...scope,
      endMs: Date.now(), status: response.statusCode }));
    return originalEmit.call(this, event, ...args);
  });
};
syncBuiltinESMExports();

const connect = pg.Pool.prototype.connect;
pg.Pool.prototype.connect = function (...args) {
  const startMs = Date.now();
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    args[args.length - 1] = function (error, client, release) {
      if (!error && client) waits.set(client, Date.now() - startMs);
      callback(error, client, release);
    };
    return connect.apply(this, args);
  }
  const result = connect.apply(this, args);
  return result.then((client) => {
    waits.set(client, Date.now() - startMs);
    return client;
  });
};

const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  const startMs = Date.now();
  const scope = context.getStore();
  const poolWaitMs = waits.get(this) ?? 0;
  waits.delete(this);
  let finished = false;
  const finish = (result, error) => {
    if (finished) return;
    finished = true;
    emit({ type: 'sql', traceId: scope?.traceId ?? null,
      operation: scope?.operation ?? 'background', startMs, endMs: Date.now(),
      poolWaitMs, rows: result?.rowCount ?? null, failed: Boolean(error) });
  };
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    args[args.length - 1] = function (error, result) {
      finish(result, error);
      callback(error, result);
    };
    return query.apply(this, args);
  }
  let result;
  try { result = query.apply(this, args); }
  catch (error) { finish(null, error); throw error; }
  if (result && typeof result.then === 'function') {
    return result.then((value) => { finish(value); return value; },
      (error) => { finish(null, error); throw error; });
  }
  result?.once?.('end', (value) => finish(value));
  result?.once?.('error', (error) => finish(null, error));
  return result;
};
