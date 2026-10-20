#!/usr/bin/env node
/** Drive the real Room-list tap and Android FCM tap entry against local fixtures. */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { openSync, closeSync } from 'node:fs';
import { once } from 'node:events';
import { extractArrivalMoments, validateArrivalCases } from './room-arrivals.mjs';
const databaseUrl = process.env.LATENCY_RIG_DATABASE_URL;
const target = new URL(databaseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) ||
    !target.pathname.includes('latency_rig') ||
    (target.searchParams.has('host') && target.searchParams.get('host') !== '/var/run/postgresql'))
  throw new Error('Arrival injection requires a local latency_rig database');
const device = process.env.LATENCY_RIG_DEVICE;
if (!device) throw new Error('LATENCY_RIG_DEVICE must identify the leased disposable emulator');
const count = Number(process.env.LATENCY_RIG_ROOM_SAMPLES ?? 20);
if (!Number.isInteger(count) || count < 20) throw new Error('At least 20 samples per case required');
const output = process.argv[2] ?? 'latency-rig-output/arrivals';
await mkdir(output, { recursive: true });
const cases = JSON.parse(await readFile(new URL('./room-arrival-cases.json', import.meta.url)));
validateArrivalCases(cases);
const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const open = (route) => adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `beeline://${route}`, 'app.usebeeline/.MainActivity');
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
const attempts = [];
let capture;
let captureFd;
try {
  const fixture = (await db.query(`SELECT r.id, r.workspace_id FROM rooms r JOIN workspaces w ON w.id=r.workspace_id
    WHERE w.name='Latency Rig 200' AND r.name='Rig room 001' AND r.parent_id IS NULL`)).rows[0];
  if (!fixture) throw new Error('Run seed-local.mjs first');
  const author = createHash('sha256').update('beeline-latency-rig:agent').digest('hex');
  // Keep the first open as an informational probe, outside the warm gate.
  let processAlreadyRunning = false;
  try { processAlreadyRunning = Boolean(adb('shell', 'pidof', 'app.usebeeline').trim()); } catch {}
  const latest = (await db.query('SELECT id FROM messages WHERE room_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [fixture.id])).rows[0];
  adb('logcat', '-c');
  const firstOpenStart = Number(adb('shell', 'date', '+%s%3N').trim());
  // A warm visit populates the same cache used on each subsequent open.
  open(`beeline/chat/${fixture.id}`);
  await pause(4000);
  const firstOpenEnd = Number(adb('shell', 'date', '+%s%3N').trim());
  try {
    const [probe] = extractArrivalMoments(adb('logcat', '-d', '-v', 'epoch'), [{
      name: processAlreadyRunning ? 'first-open-warm-process' : 'process-cold',
      targetId: latest?.id, startMs: firstOpenStart, endMs: firstOpenEnd,
    }]);
    await writeFile(`${output}/first-open.json`, JSON.stringify({ ...probe,
      durationMs: probe.paintMs - probe.startMs, informational: true, samples: 1 }, null, 2));
  } catch (error) {
    await writeFile(`${output}/first-open.json`, JSON.stringify({ informational: true,
      measured: false, reason: error.message }, null, 2));
  }
  for (let warmup = 0; warmup < 2; warmup++) {
    open('beeline/channels');
    await pause(1000);
    open(`beeline/chat/${fixture.id}`);
    await pause(2000);
  }
  // Installation and first-use work is outside the warm-session cases.
  await pause(30000);
  adb('logcat', '-c');
  captureFd = openSync(`${output}/logcat.txt`, 'w', 0o600);
  capture = spawn('adb', ['-s', device, 'logcat', '-v', 'epoch'], { stdio: ['ignore', captureFd, 'ignore'] });
  await pause(100);
  for (const scenario of cases) {
    for (let sample = 0; sample < count; sample++) {
      open('beeline/channels');
      await pause(1000);
      let targetId;
      for (let n = 0; n < scenario.unseen; n++) {
        targetId = randomBytes(32).toString('hex');
        await db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)',
          [targetId, fixture.id, author, `Rig arrival ${scenario.name} ${sample} ${n}`]);
      }
      await pause(300);
      let point;
      if (scenario.entry === 'room-list') {
        adb('shell', 'uiautomator', 'dump', '/sdcard/latency-rig.xml');
        const xml = adb('shell', 'cat', '/sdcard/latency-rig.xml');
        const node = xml.match(/<node[^>]*text="#?Rig room 001"[^>]*>/)?.[0];
        const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bounds) throw new Error('Room-list fixture row not visible; select Latency Rig 200 Workspace first');
        point = [Math.round((Number(bounds[1]) + Number(bounds[3])) / 2), Math.round((Number(bounds[2]) + Number(bounds[4])) / 2)];
      }
      // The sample begins at the physical entry action, before any navigation.
      const startMs = Number(adb('shell', 'date', '+%s%3N').trim());
      if (point) adb('shell', 'input', 'tap', ...point.map(String));
      else adb('shell', 'am', 'start', '-a', 'android.intent.action.MAIN', '-n', 'app.usebeeline/.PushNotificationActivity',
        '--es', 'google.message_id', targetId, '--es', 'type', 'room-message',
        '--es', 'workspaceId', fixture.workspace_id, '--es', 'roomId', fixture.id,
        '--es', 'channelId', fixture.id, '--es', 'messageId', targetId);
      await pause(3000);
      const endMs = Number(adb('shell', 'date', '+%s%3N').trim());
      attempts.push({ name: scenario.name, targetId, startMs, endMs });
      await writeFile(`${output}/attempts.json`, JSON.stringify(attempts, null, 2));
      console.log(`${scenario.name} ${sample + 1}/${count}`);
    }
  }
  capture.kill('SIGTERM');
  await once(capture, 'close');
  capture = undefined;
  closeSync(captureFd);
  captureFd = undefined;
  const logcat = await readFile(`${output}/logcat.txt`, 'utf8');
  const moments = extractArrivalMoments(logcat, attempts);
  await writeFile(`${output}/moments.ndjson`, moments.map((item) => JSON.stringify(item)).join('\n') + '\n');
} finally {
  if (capture) { capture.kill('SIGTERM'); await once(capture, 'close'); }
  if (captureFd !== undefined) closeSync(captureFd);
  await db.end();
}
