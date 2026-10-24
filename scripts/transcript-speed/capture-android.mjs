import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { startControl } from './control.mjs';
import { androidArtifact } from './android-artifact.mjs';
import { fixtureStimulus } from './stimulus.mjs';
import { rooms, workspace, corner, fixtureFingerprint } from './fixture.mjs';
import { summarize, percentile } from './metrics.mjs';
import { pointFor } from '../latency-rig/capture-ui.mjs';
const device = process.env.LATENCY_RIG_DEVICE;
if (!/^(emulator-\d+|127\.0\.0\.1:\d+)$/.test(device ?? '')) throw new Error('Select the leased fixture emulator with LATENCY_RIG_DEVICE');
const output = process.argv[2] ?? '/tmp/transcript-android-results';
await mkdir(output, { recursive: true });
const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8', maxBuffer: 32e6 });
if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') throw new Error('Disposable emulator required');
const artifact = androidArtifact(adb);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const open = room => adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d',
  `beeline://beeline/chat/${room}?communityId=${workspace}`, 'app.usebeeline/.MainActivity');
const dump = () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    adb('shell', 'rm', '-f', '/sdcard/transcript.xml');
    const result = adb('shell', 'uiautomator', 'dump', '/sdcard/transcript.xml');
    if (result.includes('dumped to:')) return adb('shell', 'cat', '/sdcard/transcript.xml');
  }
  throw new Error('Android accessibility dump could not get idle state after three attempts');
};
const newestPoint = xml => {
  const label = [...xml.matchAll(/content-desc="([^"]*)"/g)].map(m => m[1]).find(label => label.endsWith('Jump to newest message'));
  return label ? pointFor(xml, 'content-desc', label) : null;
};
const tap = point => { if (!point) throw new Error('Expected fixture UI control missing'); adb('shell', 'input', 'tap', ...point.map(String)); };
const control = startControl();
const stimulus = await fixtureStimulus();
const samples = [];
const refreshHz = Number(process.env.TRANSCRIPT_REFRESH_HZ ?? 60);
const frameStats = text => {
  const frames = [];
  let header;
  for (const line of text.split('\n')) {
    if (line.startsWith('Flags,') && line.includes('IntendedVsync')) { header = line.split(','); continue; }
    if (!header || !/^\d+,/.test(line)) continue;
    const values = line.split(',').map(Number);
    const intended = values[header.indexOf('IntendedVsync')], completed = values[header.indexOf('FrameCompleted')];
    if (values[0] === 0 && completed >= intended && completed < 9e18) frames.push((completed - intended) / 1e6);
  }
  const metric = regex => { const value = text.match(regex); return value ? Number(value[1]) : null; };
  return { count: metric(/Total frames rendered: (\d+)/), p50Ms: metric(/50th percentile: (\d+)ms/),
    p95Ms: metric(/95th percentile: (\d+)ms/), jankyFrames: metric(/Janky frames: (\d+)/),
    missedVsync: metric(/Number Missed Vsync: (\d+)/),
    retainedFrameCount: frames.length, retainedFrameP95Ms: percentile(frames, .95), rawMs: frames };
};
async function capture(name, duration, action) {
  adb('shell', 'dumpsys', 'gfxinfo', 'app.usebeeline', 'reset');
  const sample = await control.capture(name, duration, action);
  const rawFrames = adb('shell', 'dumpsys', 'gfxinfo', 'app.usebeeline', 'framestats');
  const result = { ...summarize(sample, refreshHz), raw: sample, uiFrames: frameStats(rawFrames) };
  samples.push(result);
  await writeFile(`${output}/capture.json`, JSON.stringify({ status: 'partial', device, refreshHz, samples }, null, 2));
  console.log(name, result.uiFrames.count, 'UI frames');
}
try {
  open(rooms[0]); await pause(3000); open(rooms[0]); await pause(1500); await control.ready();
  const xml = dump();
  if (!xml.includes('Transcript A')) throw new Error('The fixture Room did not open');
  const newest = newestPoint(xml);
  if (newest) { tap(newest); await pause(2000); }
  for (let repeat = 0; repeat < 3; repeat++) {
    await capture('idle', 2000, async () => {});
    const composer = pointFor(dump(), 'content-desc', 'Message');
    tap(composer); await pause(500);
    for (const char of 'measure') await capture('keystroke', 650, async () => { adb('shell', 'input', 'text', char); });
    adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A');
    adb('shell', 'input', 'keyevent', 'KEYCODE_DEL'); adb('shell', 'input', 'keyevent', '4');
    await pause(500);
    await capture('scroll', 4000, async () => {
      for (let i = 0; i < 3; i++) { adb('shell', 'input', 'swipe', '500', '900', '500', '1500', '500'); await pause(150); }
    });
    await capture('fling', 4000, async () => {
      for (let i = 0; i < 4; i++) { adb('shell', 'input', 'swipe', '500', '700', '500', '1850', '120'); await pause(350); }
    });
    if (process.env.TRANSCRIPT_SKIP_HISTORY !== '1') {
    const oldest = xml => Math.min(...Array.from(xml.matchAll(/Fixture (\d{4})/g), m => Number(m[1])));
    const oldestBefore = Math.min(970, oldest(dump()));
    await capture('history-prepend', 25000, async () => {
      for (let i = 0; i < 30; i++) {
        adb('shell', 'input', 'swipe', '500', '550', '500', '2000', '90'); await pause(100);
      }
    });
    samples.at(-1).history = { oldestBefore, oldestAfter: oldest(dump()) };
    if (!(samples.at(-1).history.oldestAfter < oldestBefore)) throw new Error('Android history gestures did not reveal an older fixture row');
    }
    open(rooms[1]); await pause(1200); open(rooms[0]); await pause(1200);
    let atNewest = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const current = dump();
      const jump = newestPoint(current);
      if (!jump && (current.includes('Fixture 0999') || current.includes('Incoming fixture') || current.includes('Settlement-'))) { atNewest = true; break; }
      if (jump) tap(jump);
      else adb('shell', 'input', 'swipe', '500', '1900', '500', '500', '150');
      await pause(1500);
    }
    if (!atNewest) throw new Error('Android newest-content precondition did not settle');
    let incoming;
    await capture('incoming', 2500, async () => { incoming = await stimulus.incoming(); });
    const incomingXml = dump();
    samples.at(-1).visible = incomingXml.includes(incoming.text);
    if (!samples.at(-1).visible) throw new Error('Android incoming message did not become visible');
    if (!samples.at(-1).rowCommits) throw new Error('Incoming message was not captured inside the sampling window');
    const memoryBefore = adb('shell', 'dumpsys', 'meminfo', 'app.usebeeline');
    await capture('warm-room-switches', 30000, async () => {
      for (let i = 0; i < 20; i++) { open(rooms[i % 2]); await pause(900); }
    });
    samples.at(-1).memory = { switches: 20, before: memoryBefore, after: adb('shell', 'dumpsys', 'meminfo', 'app.usebeeline') };
    open(corner); await pause(2000);
    // Verify the same live path outside the frame sampling window so the
    // accessibility dump does not distort streaming frame times.
    await stimulus.stream(async () => {
      const screenshot = `${output}/streams-${repeat}.png`;
      await writeFile(screenshot, execFileSync('adb', ['-s', device, 'exec-out', 'screencap', '-p']));
      const visible = execFileSync('tesseract', [screenshot, 'stdout'], { encoding: 'utf8' });
      await writeFile(`${output}/streams-${repeat}.txt`, visible);
      if (!/Stream [0O]:/.test(visible) || !/Stream 1:/.test(visible)) throw new Error('Android screenshot did not show both live streams');
    });
    await capture('concurrent-streams', 5000, async () => { await stimulus.stream(); });
    if (!samples.at(-1).rowCommits) throw new Error('Streaming rows were not captured inside the sampling window');
    open(rooms[0]); await pause(2000);
    tap(pointFor(dump(), 'content-desc', 'Message'));
    const sent = `Settlement-${repeat}-${Date.now()}`;
    adb('shell', 'input', 'text', sent); adb('shell', 'input', 'keyevent', '4'); await pause(500);
    const send = pointFor(dump(), 'content-desc', 'Send message');
    await capture('optimistic-send', 3000, async () => { tap(send); });
    samples.at(-1).serverSettled = await stimulus.settled(sent);
    if (!samples.at(-1).serverSettled) throw new Error('Android optimistic send did not settle on the fixture server');
    if (!samples.at(-1).rowCommits) throw new Error('Optimistic send was not captured inside the sampling window');
  }
  await writeFile(`${output}/capture.json`, JSON.stringify({ status: 'partial', device, fixtureFingerprint,
    ...artifact,
    checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    refreshHz,
    profilingOverhead: 'not yet compared with ordinary build; polling suspended inside sample',
    blankArea: null, keystrokeToPaint: null, samples }, null, 2));
} finally { control.close(); await stimulus.close(); }
