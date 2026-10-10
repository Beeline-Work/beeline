#!/usr/bin/env node
/** Server/wire baseline only. These numbers are not route first-frame timings. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { percentile, serialDepth } from './analyze.mjs';

const origin = new URL(process.env.LATENCY_RIG_ORIGIN ?? 'http://127.0.0.1:8081');
if (!['localhost', '127.0.0.1', '::1'].includes(origin.hostname))
  throw new Error('HTTP baseline requires a local proxy');
const secret = process.env.LATENCY_RIG_REVIEW_SECRET;
if (!secret) throw new Error('LATENCY_RIG_REVIEW_SECRET is required');
const iterations = Number(process.env.LATENCY_RIG_ITERATIONS ?? 20);
if (!Number.isInteger(iterations) || iterations < 20) throw new Error('At least 20 samples are required');
const id = (name) => {
  const hex = createHash('sha256').update(`beeline-latency-rig:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const login = await fetch(new URL('/v1/auth/review/exchange', origin), {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ secret }),
});
if (!login.ok) throw new Error(`local reviewer exchange failed: ${login.status}`);
const { accessToken } = await login.json();
const headers = { authorization: `Bearer ${accessToken}` };
const cases = [{ name: 'workspaces', path: '/v1/phone/workspaces' }];
for (const count of [1, 10, 200]) {
  cases.push({ name: `chats-${count}`, path: `/v1/phone/workspaces/${id(`workspace-${count}`)}/chats` });
  cases.push({ name: `room-${count}`, path: `/v1/phone/rooms/${id(`room-${count}-0`)}` });
}
cases.push({ name: 'corners-300', path: `/v1/phone/rooms/${id('room-200-0')}/corners` });
const rows = [];
for (const scenario of cases) {
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const startEpochMs = Date.now();
    const start = performance.now();
    const response = await fetch(new URL(scenario.path, origin), { headers });
    const body = await response.arrayBuffer();
    if (!response.ok) throw new Error(`${scenario.name} failed: ${response.status}`);
    samples.push({ ms: performance.now() - start, bytes: body.byteLength,
      startEpochMs, endEpochMs: Date.now() });
  }
  rows.push({ name: scenario.name, n: samples.length,
    p50Ms: Math.round(percentile(samples.map((s) => s.ms), .5)),
    p95Ms: Math.round(percentile(samples.map((s) => s.ms), .95)),
    p99Ms: Math.round(percentile(samples.map((s) => s.ms), .99)),
    bytes: Math.max(...samples.map((s) => s.bytes)), samples });
}
if (process.env.LATENCY_RIG_SQL_LOG) {
  const records = (await readFile(process.env.LATENCY_RIG_SQL_LOG, 'utf8'))
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  for (const row of rows) {
    const runs = row.samples.map((sample) => {
      const operation = records.find((record) => record.type === 'operation' &&
        record.startMs >= sample.startEpochMs && record.endMs <= sample.endEpochMs);
      if (!operation) throw new Error(`missing server operation span for ${row.name}`);
      const sql = records.filter((record) => record.type === 'sql' && record.traceId === operation.traceId);
      return { statements: sql.length, depth: serialDepth(sql),
        poolWaitMs: sql.reduce((sum, span) => sum + span.poolWaitMs, 0) };
    });
    row.maxSqlStatements = Math.max(...runs.map((run) => run.statements));
    row.maxSqlDepth = Math.max(...runs.map((run) => run.depth));
    row.maxPoolWaitMs = Math.max(...runs.map((run) => run.poolWaitMs));
  }
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const lines = ['# Local HTTP baseline', '',
  `Commit: \`${commit}\`; captured ${new Date().toISOString()}.`,
  `Shape: ${process.env.LATENCY_RIG_RTT_MS ?? 100} ms configured RTT, ${process.env.LATENCY_RIG_JITTER_MS ?? 0} ms jitter, ${process.env.LATENCY_RIG_MBPS ?? 10} Mbps; local HTTP, no TLS.`,
  'This is signed local monolith and shaped-proxy response timing. It does not measure Android first frames.', '',
  '| Operation | n | p50 | p95 | p99 | Max response bytes | Max SQL / depth / pool wait |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...rows.map((row) => `| ${row.name} | ${row.n} | ${row.p50Ms} ms | ${row.p95Ms} ms | ${row.p99Ms} ms | ${row.bytes} | ${row.maxSqlStatements ?? '—'} / ${row.maxSqlDepth ?? '—'} / ${row.maxPoolWaitMs ?? '—'} ms |`), ''];
const output = process.argv[2];
if (output) await writeFile(output, lines.join('\n'));
else console.log(lines.join('\n'));
