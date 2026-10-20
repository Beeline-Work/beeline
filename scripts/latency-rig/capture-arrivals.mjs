#!/usr/bin/env node
/** Drive the real Room-list tap and Android FCM tap entry against local fixtures. */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import os from 'node:os';
import { pointFor, requireRoomList } from './capture-ui.mjs';
import { openSync, closeSync } from 'node:fs';
import { once } from 'node:events';
import { extractArrivalMoments, nativeArrivalMoment, findNativeArrival, validateArrivalCases } from './room-arrivals.mjs';
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
const dump = () => { adb('shell', 'uiautomator', 'dump', '/sdcard/latency-rig.xml'); return adb('shell', 'cat', '/sdcard/latency-rig.xml'); };
const tap = (point) => adb('shell', 'input', 'tap', ...point.map(String));
const open = (route) => adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `beeline://${route}`, 'app.usebeeline/.MainActivity');
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
const attempts = [];
const hostLoad = [];
const recordLoad = () => hostLoad.push({ atMs: Date.now(), load: os.loadavg(), freeMemory: os.freemem(), totalMemory: os.totalmem(), cpus: os.availableParallelism() });
recordLoad();
const loadTimer = setInterval(recordLoad, 10_000);
loadTimer.unref();
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
  let listReady = false;
  for (let ready = 0; ready < 30; ready++) {
    const xml = dump();
    if (pointFor(xml, 'content-desc', 'all conversations')) {
      if (pointFor(xml, 'text', '#Rig room 001') && !pointFor(xml, 'content-desc', 'Close Workspace switcher')) { listReady = true; break; }
      const fixtureWorkspace = pointFor(xml, 'content-desc', 'Latency Rig 200');
      if (fixtureWorkspace) tap(fixtureWorkspace);
      else {
        const switchLabel = xml.match(/content-desc="([^"]+ — switch Workspace)"/)?.[1];
        const switchPoint = switchLabel && pointFor(xml, 'content-desc', switchLabel);
        if (switchPoint) tap(switchPoint);
      }
    }
    if (pointFor(xml, 'content-desc', 'Message')) adb('shell', 'input', 'keyevent', '4');
    if (xml.includes('Continue with GitHub')) throw new Error('Sign in to the local fixture before capture');
    await pause(500);
  }
  if (!listReady) throw new Error('Room list did not become ready before warmup');
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
    adb('shell', 'input', 'keyevent', '4');
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
  const entry = process.env.LATENCY_RIG_ENTRY;
  if (entry && !['room-list', 'push'].includes(entry)) throw new Error('LATENCY_RIG_ENTRY must be room-list or push');
  const scenarios = [...cases];
  if (process.env.LATENCY_RIG_NIGHTLY === '1') scenarios.push(
    { name: 'warm', entry: 'room-list', unseen: 0 },
    { name: 'send-text', entry: 'send-text', unseen: 0 });
  for (const scenario of scenarios.filter((item) => !entry || item.entry === entry)) {
    // Existing watch/covering reads are setup, not part of the send interaction.
    if (scenario.entry === 'send-text') await pause(10000);
    for (let sample = 0; sample < count; sample++) {
      if (scenario.entry !== 'send-text') adb('shell', 'input', 'keyevent', '4');
      await pause(1000);
      let targetId = (await db.query('SELECT id FROM messages WHERE room_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [fixture.id])).rows[0]?.id;
      for (let n = 0; n < scenario.unseen; n++) {
        targetId = randomBytes(32).toString('hex');
        await db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)',
          [targetId, fixture.id, author, `Rig ${targetId.slice(0, 16)}`]);
      }
      await pause(300);
      let point;
      if (scenario.entry === 'send-text') {
        const composer = pointFor(dump(), 'content-desc', 'Message');
        if (!composer) throw new Error('Send-text requires the visible Room composer');
        tap(composer);
        targetId = randomBytes(32).toString('hex');
        adb('shell', 'input', 'text', `Rig%s${targetId.slice(0, 16)}`);
        adb('shell', 'input', 'keyevent', '4');
        point = pointFor(dump(), 'content-desc', 'Send message');
        if (!point) throw new Error('Send-text fixture has no enabled send button');
      } else {
        let xml;
        for (let precondition = 0; precondition < 3; precondition++) {
          xml = dump();
          const close = pointFor(xml, 'content-desc', 'Close Workspace switcher');
          if (!close) break;
          tap(close);
        }
        const roomPoint = requireRoomList(xml);
        if (scenario.entry === 'room-list') point = roomPoint;
      }
      const armedAtMs = Number(adb('shell', 'date', '+%s%3N').trim());
      adb('shell', 'am', 'broadcast', '-a', 'app.usebeeline.LATENCY_RIG_EXPECT', '-n', 'app.usebeeline/.LatencyRigReceiver',
        '--es', 'needle', targetId.slice(0, 16), '--es', 'case', scenario.name, '--es', 'entry', scenario.entry);
      await writeFile(`${output}/pending-attempt.json`, JSON.stringify({ name: scenario.name, unseen: scenario.unseen, targetId }, null, 2));
      if (point) tap(point);
      else adb('shell', 'am', 'start', '-a', 'android.intent.action.MAIN', '-n', 'app.usebeeline/.PushNotificationActivity',
        '--es', 'google.message_id', targetId, '--es', 'type', 'room-message',
        '--es', 'channelId', fixture.id, '--es', 'roomId', fixture.id,
        '--es', 'workspaceId', fixture.workspace_id, '--es', 'messageId', targetId);
      let nativeOutput = '';
      let line = '';
      for (let probe = 0; probe < 50; probe++) {
        await pause(200);
        nativeOutput = adb('logcat', '-d', '-s', 'LATENCY_NATIVE:W');
        line = findNativeArrival(nativeOutput, scenario.name, targetId.slice(0, 16), armedAtMs);
        if (line) break;
      }
      await writeFile(`${output}/native-${scenario.name}-${sample}.txt`, line);
      const moment = nativeArrivalMoment(line, scenario.name);
      await pause(2000);
      const endMs = Number(adb('shell', 'date', '+%s%3N').trim());
      attempts.push({ ...moment, targetId, endMs });
      await writeFile(`${output}/attempts.json`, JSON.stringify(attempts, null, 2));
      console.log(`${scenario.name} ${sample + 1}/${count}`);
    }
  }
  capture.kill('SIGTERM');
  await once(capture, 'close');
  capture = undefined;
  closeSync(captureFd);
  captureFd = undefined;
  const moments = attempts.map(({ targetId, ...moment }) => moment);
  await writeFile(`${output}/moments.ndjson`, moments.map((item) => JSON.stringify(item)).join('\n') + '\n');
} finally {
  clearInterval(loadTimer);
  recordLoad();
  await writeFile(`${output}/host-load.json`, JSON.stringify(hostLoad, null, 2));
  if (capture) { capture.kill('SIGTERM'); await once(capture, 'close'); }
  if (captureFd !== undefined) closeSync(captureFd);
  await db.end();
}
