#!/usr/bin/env node
/** One Room verdict per shaped profile; unmeasured routes remain explicit. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summarize } from './analyze.mjs';

const root = process.argv[2];
if (!root) throw new Error('usage: sweep-summary.mjs <sweep-directory>');
const lines = [
  '# Warm Room network sweep', '',
  'Each profile ran 30 opens on the signed local fixture. A 1% whole-request failure is an outage injection, not packet loss. CPU quota is an uncalibrated operating scenario; HTTP is local without TLS. This table does not establish a 39-route/26-tap launch verdict.', '',
  '| Configured RTT | Successful frames | p50 | p95 | <450 ms | Prepaint HTTP | Result |',
  '|---:|---:|---:|---:|---|---:|---|',
];
for (const rtt of [50, 100, 200, 300]) {
  const rows = (await readFile(join(root, String(rtt), 'samples.ndjson'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const report = summarize(rows);
  const room = report.rows.find((row) => row.kind === 'route' &&
    row.name === '/beeline/chat/[channelId]' && row.variant === 'warm');
  if (!room || room.samples < 20) throw new Error(`${rtt} ms profile has fewer than 20 successful Room frames`);
  lines.push(`| ${rtt} ms | ${room.samples}/30 | ${Math.round(room.p50Ms)} ms | ${Math.round(room.p95Ms)} ms | <450 ms | ${room.maxPrepaintHttpCount} | ${room.timingPass && room.maxPrepaintHttpCount === 0 ? 'PASS' : 'FAIL'} |`);
}
console.log(lines.join('\n'));
