#!/usr/bin/env node
/** Drive Room arrivals and visible tap actions against local Android fixtures. */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import os from 'node:os';
import { calibrateDeviceClock } from './device-clock.mjs';
import { createDeviceClockReader } from './device-clock-reader.mjs';
import { isKeyboardShown, pointFor, requireRoomList } from './capture-ui.mjs';
import { dumpUi } from './dump-ui.mjs';
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
const smoke = process.env.LATENCY_RIG_SMOKE === '1';
const taps = ['react-message', 'open-corner', 'switch-tabs', 'open-composer'];
const count = Number(process.env.LATENCY_RIG_ROOM_SAMPLES ?? (smoke ? 1 : 20));
if (!Number.isInteger(count) || count < (smoke ? 1 : 20)) throw new Error(`At least ${smoke ? 1 : 20} samples per case required`);
const output = process.argv[2] ?? 'latency-rig-output/arrivals';
await mkdir(output, { recursive: true });
const cases = JSON.parse(await readFile(new URL('./room-arrival-cases.json', import.meta.url)));
validateArrivalCases(cases);
const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let dumpStep = 'Room list readiness';
const dump = () => dumpUi(adb, dumpStep);
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
let clockReader;
try {
  clockReader = createDeviceClockReader(device);
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
    const xml = await dump();
    if (pointFor(xml, 'content-desc', 'all conversations')) {
      if (pointFor(xml, 'content-desc', 'Latency Rig 200 — switch Workspace') &&
          pointFor(xml, 'text', '#Rig room 001') && !pointFor(xml, 'content-desc', 'Close Workspace switcher')) { listReady = true; break; }
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
  if (entry && !['room-list', 'push', 'timed-taps', ...taps].includes(entry)) throw new Error('LATENCY_RIG_ENTRY must be room-list, push, or a timed tap action');
  const scenarios = [...cases];
  if (process.env.LATENCY_RIG_NIGHTLY === '1') scenarios.push(
    { name: 'warm', entry: 'room-list', unseen: 0 },
    { name: 'send-text', entry: 'send-text', unseen: 0 });
  if (process.env.LATENCY_RIG_NIGHTLY === '1' || smoke || entry === 'timed-taps' || taps.includes(entry))
    scenarios.push(...taps.map(name => ({ name, entry: name, unseen: 0 })));
  for (const scenario of scenarios.filter((item) => !entry || (entry === 'timed-taps' ? taps.includes(item.entry) : item.entry === entry))) {
    // Existing watch/covering reads are setup, not part of the send interaction.
    if (scenario.entry === 'send-text') await pause(10000);
    let sendComposer;
    let sendButton;
    for (let sample = 0; sample < count; sample++) {
      dumpStep = `${scenario.name} setup (sample ${sample + 1}/${count})`;
      if (scenario.entry !== 'send-text' && !taps.includes(scenario.entry)) adb('shell', 'input', 'keyevent', '4');
      await pause(1000);
      let targetId = (await db.query('SELECT id FROM messages WHERE room_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [fixture.id])).rows[0]?.id;
      for (let n = 0; n < scenario.unseen; n++) {
        targetId = randomBytes(32).toString('hex');
        await db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)',
          [targetId, fixture.id, author, `Rig ${targetId.slice(0, 16)}`]);
      }
      await pause(300);
      let point;
      if (taps.includes(scenario.entry)) {
        // Setup is outside the timer. Each result must be absent before arming.
        open(`beeline/chat/${fixture.id}`);
        await pause(1500);
        adb('shell', 'input', 'keyevent', '4');
        await pause(500);
        if (scenario.entry === 'switch-tabs') {
          open('beeline/channels');
          await pause(1500);
          const all = pointFor(await dump(), 'content-desc', 'all conversations');
          if (!all) throw new Error('Switch-tabs requires the conversation tabs');
          tap(all);
          await pause(500);
          const xml = await dump();
          if (xml.includes('No pinned conversations yet.')) throw new Error('Target tab content already visible');
          point = pointFor(xml, 'content-desc', 'pinned conversations');
        } else {
          open(`beeline/chat/${fixture.id}`);
          await pause(1500);
          if (scenario.entry === 'open-composer') {
            const keyboardShown = () => isKeyboardShown(adb('shell', 'dumpsys', 'input_method'));
            if (keyboardShown()) { adb('shell', 'input', 'keyevent', '4'); await pause(500); }
            if (keyboardShown()) throw new Error('Composer setup requires a dismissed keyboard');
            point = pointFor(await dump(), 'content-desc', 'Message');
          } else if (scenario.entry === 'react-message') {
            targetId = randomBytes(32).toString('hex');
            await db.query('INSERT INTO messages(id,room_id,author_id,text,reactions) VALUES($1,$2,$3,$4,$5::jsonb)',
              [targetId, fixture.id, author, `Rig ${targetId.slice(0, 16)}`, JSON.stringify({'👍': [author]})]);
            await pause(1500);
            // UI Automator serializes emoji as numeric XML character references.
            const xml = (await dump()).replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, value) =>
              String.fromCodePoint(value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value)));
            point = pointFor(xml, 'resource-id', `reaction-chip-${targetId}-👍`);
            const chip = [...xml.matchAll(/<node\b[^>]*>/g)].map(m => m[0])
              .find(node => node.includes(`resource-id="reaction-chip-${targetId}-👍"`));
            if (!chip?.includes('content-desc="👍, 1 reaction"')) throw new Error('Reaction setup requires one existing reaction');
          } else {
            const doorXml = await dump();
            const doorNode = [...doorXml.matchAll(/<node\b[^>]*>/g)].map(m => m[0]).find(n => n.includes('resource-id="room-corners-menu"'));
            const doorLabel = doorNode?.match(/content-desc="([^"]+)"/)?.[1];
            const door = doorLabel && pointFor(doorXml, 'content-desc', doorLabel);
            if (!door) throw new Error('Room corners door missing');
            tap(door);
            await pause(1500);
            const xml = await dump();
            const rowNode = [...xml.matchAll(/<node\b[^>]*>/g)].map(m => m[0])
              .find(node => /resource-id="room-corner-[a-f0-9-]{36}"/.test(node));
            const cornerId = rowNode?.match(/resource-id="room-corner-([a-f0-9-]{36})"/)?.[1];
            const row = rowNode?.match(/content-desc="([^"]+)"/)?.[1];
            if (!cornerId || !row) throw new Error('No visible seeded corner row');
            const corner = (await db.query('SELECT id FROM rooms WHERE id=$1 AND parent_id=$2', [cornerId, fixture.id])).rows[0];
            if (!corner) throw new Error('Visible corner is outside the fixture Room');
            targetId = randomBytes(32).toString('hex');
            await db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)',
              [targetId, corner.id, author, `Rig ${targetId.slice(0, 16)}`]);
            await pause(500);
            point = pointFor(await dump(), 'content-desc', row);
          }
        }
        if (!point) throw new Error(`Visible action missing: ${scenario.entry}`);
      } else if (scenario.entry === 'send-text') {
        const composer = sendComposer ?? pointFor(await dump(), 'content-desc', 'Message');
        if (!composer) throw new Error('Send-text requires the visible Room composer');
        sendComposer = composer;
        tap(composer);
        await pause(300);
        adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A');
        adb('shell', 'input', 'keyevent', 'KEYCODE_DEL');
        targetId = randomBytes(32).toString('hex');
        adb('shell', 'input', 'text', `Rig%s${targetId.slice(0, 16)}`);
        await pause(300);
        adb('shell', 'input', 'keyevent', '4');
        await pause(500);
        // Sending starts animated status rows that prevent UI Automator idle.
        // Reuse the established controls; native text paint still proves every send.
        point = sendButton ?? pointFor(await dump(), 'content-desc', 'Send message');
        if (!point) throw new Error('Send-text fixture has no enabled send button');
        sendButton = point;
      } else {
        let xml;
        for (let precondition = 0; precondition < 3; precondition++) {
          xml = await dump();
          const close = pointFor(xml, 'content-desc', 'Close Workspace switcher');
          if (!close) break;
          tap(close);
        }
        const roomPoint = requireRoomList(xml);
        if (scenario.entry === 'room-list') point = roomPoint;
      }
      const readDeviceMs = () => clockReader.read();
      const clockBefore = await calibrateDeviceClock(readDeviceMs);
      const armedAtMs = clockBefore.deviceMs;
      adb('shell', 'am', 'broadcast', '-a', 'app.usebeeline.LATENCY_RIG_EXPECT', '-n', 'app.usebeeline/.LatencyRigReceiver',
        '--es', 'needle', targetId.slice(0, 16), '--es', 'case', scenario.name, '--es', 'entry', scenario.entry);
      await writeFile(`${output}/pending-attempt.json`, JSON.stringify({ name: scenario.name, unseen: scenario.unseen, targetId }, null, 2));
      const deadline = Date.now() + 5000;
      if (point) tap(point);
      else adb('shell', 'am', 'start', '-a', 'android.intent.action.MAIN', '-n', 'app.usebeeline/.PushNotificationActivity',
        '--es', 'google.message_id', targetId, '--es', 'type', 'room-message',
        '--es', 'channelId', fixture.id, '--es', 'roomId', fixture.id,
        '--es', 'workspaceId', fixture.workspace_id, '--es', 'messageId', targetId);
      let nativeOutput = '';
      let line = '';
      while (Date.now() < deadline) {
        await pause(200);
        nativeOutput = adb('logcat', '-d', '-s', 'LATENCY_NATIVE:W');
        line = findNativeArrival(nativeOutput, scenario.name, targetId.slice(0, 16), armedAtMs);
        if (line) break;
      }
      await writeFile(`${output}/native-${scenario.name}-${sample}.txt`, line);
      const moment = line ? nativeArrivalMoment(line, scenario.name) : {
        kind: scenario.entry === 'send-text' || taps.includes(scenario.entry) ? 'tap' : 'route',
        name: scenario.entry === 'send-text' || taps.includes(scenario.entry) ? scenario.name : '/beeline/chat/[channelId]',
        variant: scenario.entry === 'send-text' || taps.includes(scenario.entry) ? 'warm' : scenario.name,
        startMs: armedAtMs, paintMs: armedAtMs + 5000, timedOut: true,
      };
      // A timeout is a censored failure, never evidence that the row painted.
      // Keep collecting the matrix rather than losing every later case.
      await pause(2000);
      const clockAfter = await calibrateDeviceClock(readDeviceMs);
      const endMs = clockAfter.deviceMs;
      attempts.push({ ...moment, targetId, endMs, clockDomain: 'device',
        clockSync: { before: clockBefore, after: clockAfter } });
      await writeFile(`${output}/attempts.json`, JSON.stringify(attempts, null, 2));
      if (smoke && moment.timedOut) throw new Error(`Smoke completion never became visible: ${scenario.name}`);
      if (scenario.entry === 'switch-tabs') {
        const all = pointFor(await dump(), 'content-desc', 'all conversations');
        if (!all) throw new Error('Cannot restore All after tab capture');
        tap(all);
        await pause(500);
      }
      if (scenario.entry === 'react-message') await db.query('DELETE FROM messages WHERE id=$1', [targetId]);
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
  clockReader?.close();
  clearInterval(loadTimer);
  recordLoad();
  await writeFile(`${output}/host-load.json`, JSON.stringify(hostLoad, null, 2));
  if (capture) { capture.kill('SIGTERM'); await once(capture, 'close'); }
  if (captureFd !== undefined) closeSync(captureFd);
  await db.end();
}
