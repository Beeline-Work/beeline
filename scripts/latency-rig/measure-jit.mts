/** Compare the actual phone read paths on a disposable seed-local.mjs fixture. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PhoneService } from '../../apps/server/src/phone-service.ts';
import { PostgresDatabase, postgresPoolConfig } from '../../apps/server/src/database.ts';

const url = process.env.LATENCY_RIG_DATABASE_URL;
if (!url) throw Error('LATENCY_RIG_DATABASE_URL is required');
const target = new URL(url);
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
    (target.searchParams.has('host') && target.searchParams.get('host') !== '/var/run/postgresql') ||
    !target.pathname.includes('latency_rig')) {
  throw Error('Use a disposable loopback latency_rig database');
}
const viewer = createHash('sha256').update('beeline:play-review-identity').digest('hex');
const room = 'f13fbac4-e500-4f81-8c20-78bc02c3aac8';
const workspace = 'dc27ab0c-32d1-49ca-8361-e3ff4664bcd1';
const modes = ['on', 'off'] as const;
const connections = modes.map((jit) => {
  const config = postgresPoolConfig(url, 1);
  if (jit === 'on') config.options = '-c jit=on'; // Before this change.
  const db = new PostgresDatabase('', 1, { pool: new Pool(config) });
  return { jit, db, phone: new PhoneService(db, 'http://127.0.0.1:18890') };
});
const cases = [
  ['readCorners', (phone: PhoneService) => phone.readCorners(room, viewer)],
  ['room list', (phone: PhoneService) => phone.readChats(workspace, viewer)],
  ['transcript page', (phone: PhoneService) => phone.readHistory(room, viewer)],
] as const;
const output = [];
try {
  for (const [name, read] of cases) {
    const samples = { on: [] as number[], off: [] as number[] };
    const sizes = { on: 0, off: 0 };
    for (let i = 0; i < 33; i++) {
      for (const { jit, phone } of i % 2 ? [...connections].reverse() : connections) {
        const start = performance.now();
        const value = await read(phone);
        const elapsed = performance.now() - start;
        if (!value) throw Error(name + ' returned null');
        sizes[jit] = JSON.stringify(value).length;
        if (i >= 3) samples[jit].push(elapsed);
      }
    }
    for (const jit of modes) {
      const times = samples[jit].sort((a, b) => a - b);
      output.push({ jit, name, p50: times[14], p95: times[28], samples: times.length, responseBytes: sizes[jit] });
    }
  }
} finally {
  await Promise.all(connections.map(({ db }) => db.close()));
}
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
