#!/usr/bin/env node
/** Estimate phone-to-server RTT from matched, clock-synchronized production spans. */
import { readFile } from 'node:fs/promises';
import { percentile } from './analyze.mjs';

const path = process.argv[2];
if (!path) throw new Error('usage: derive-rtt.mjs matched-production-spans.ndjson');
const rows = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const oneWay = rows.map((row, index) => {
  if (typeof row.phoneFirstByteEpochMs !== 'number' ||
      typeof row.serverFinishEpochMs !== 'number')
    throw new Error(`line ${index + 1}: expected matched phoneFirstByteEpochMs and serverFinishEpochMs`);
  const observed = row.phoneFirstByteEpochMs - row.serverFinishEpochMs;
  if (!Number.isFinite(observed) || observed < 0)
    throw new Error(`line ${index + 1}: unsynchronized or invalid clocks`);
  return observed;
});
if (oneWay.length < 20) throw new Error('At least 20 matched production requests are required');
const median = percentile(oneWay, .5);
const p95 = percentile(oneWay, .95);
console.log(JSON.stringify({ matchedRequests: oneWay.length,
  observedDownstreamMedianMs: median, observedDownstreamP95Ms: p95,
  symmetricRttEstimateMedianMs: median * 2,
  symmetricRttEstimateP95Ms: p95 * 2,
  caveat: 'RTT doubling assumes symmetric paths and synchronized phone/server clocks' }, null, 2));
