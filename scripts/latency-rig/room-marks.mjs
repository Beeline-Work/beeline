#!/usr/bin/env node
/** Extract release Room-open marks from `adb logcat -v epoch` into rig moments. */
import { readFile, writeFile } from 'node:fs/promises';

const [input, output, variant = 'cold'] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: room-marks.mjs logcat.txt moments.ndjson [variant]');
const lines = (await readFile(input, 'utf8')).split(/\r?\n/);
const moments = [];
let open;
for (const line of lines) {
  const epoch = /^\s*(\d{10})\.(\d{3})\s/.exec(line);
  const marker = /\[ROOM_OPEN\]\s*(\{.*\})/.exec(line);
  if (!epoch || !marker) continue;
  const mark = JSON.parse(marker[1]);
  const atMs = Number(epoch[1]) * 1000 + Number(epoch[2]);
  if (mark.phase === 'nav-dispatch' || mark.phase === 'route-mount') {
    if (!open || mark.phase === 'nav-dispatch') open = { startMs: atMs, markT: mark.t };
  }
  if (mark.phase === 'newest-frame' && open) {
    const paintMs = open.startMs + mark.t - open.markT;
    moments.push({ kind: 'route', name: '/beeline/chat/[channelId]', variant,
      startMs: open.startMs, paintMs, endMs: Math.max(atMs, paintMs) + 100 });
    open = undefined;
  }
}
await writeFile(output, moments.map((moment) => JSON.stringify(moment)).join('\n') +
  (moments.length ? '\n' : ''));
console.log(`Extracted ${moments.length} Room first-frame samples.`);
