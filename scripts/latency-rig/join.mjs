#!/usr/bin/env node
/** Join device paint marks with local proxy and SQL spans by a bounded run window. */
import { readFile, writeFile } from 'node:fs/promises';
import { hostClockMoment } from './device-clock.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
async function records(path) {
  if (!path) return [];
  return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
const momentsPath = option('--moments');
const outPath = option('--out');
if (!momentsPath || !outPath)
  throw new Error('usage: join.mjs --moments moments.ndjson --proxy proxy.ndjson [--sql sql.ndjson] --out samples.ndjson');
const moments = (await records(momentsPath)).map(hostClockMoment);
const proxy = await records(option('--proxy'));
const sql = await records(option('--sql'));
const requestKey = (span) => `${span.traceId}:${span.startMs}`;
const requestEnds = new Map(proxy.filter(span => span.type === 'phone-request' && span.phase === 'end')
  .map(span => [requestKey(span), span]));
const samples = moments.map((moment, index) => {
  const uncertainty = moment.clockUncertaintyMs ?? 0;
  if (index && moment.startMs - uncertainty < moments[index - 1].endMs + (moments[index - 1].clockUncertaintyMs ?? 0))
    throw new Error('overlapping moment windows cannot be attributed by time; capture serially or provide trace IDs');
  const within = (span) => span.startMs >= moment.startMs - uncertainty && span.startMs < moment.endMs + uncertainty;
  const matchedProxy = proxy.filter(within);
  const traceIds = new Set(matchedProxy.map((span) => span.traceId).filter(Boolean));
  return {
    ...moment,
    http: matchedProxy.filter((span) => span.type === 'http'),
    ws: matchedProxy.filter((span) => span.type === 'ws'),
    phone: matchedProxy.filter(span => span.type === 'phone-request' && span.phase === 'start').map(span => {
      const end = requestEnds.get(requestKey(span));
      // Keep an admitted request with no reply visible to the evaluator, never as zero work.
      return { ...span, ...end, endMs: end?.endMs ?? moment.endMs + uncertainty + 1,
        complete: end?.complete === true };
    }),
    sql: sql.filter((span) => span.type === 'sql' && span.traceId !== null &&
      within(span) && (!traceIds.size || traceIds.has(span.traceId))),
  };
});
await writeFile(outPath, samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
console.log(`Joined ${samples.length} samples, ${proxy.length} proxy spans, ${sql.length} SQL spans.`);
