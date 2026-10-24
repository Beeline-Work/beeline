/** External Room-open probe: native release markers, plus process memory. */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { rooms, workspace } from './fixture.mjs';
const device = process.env.LATENCY_RIG_DEVICE;
if (!/^emulator-\d+$/.test(device ?? '')) throw new Error('Select a leased fixture emulator');
const output = process.argv[2] ?? '/tmp/transcript-open-results';
await mkdir(output, { recursive: true });
const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8', maxBuffer: 32e6 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const open = route => adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `beeline://${route}`, 'app.usebeeline/.MainActivity');
const samples = [];
for (const variant of ['cold-process-retained-cache', 'warm', 'cache-miss']) {
  for (let repeat = 0; repeat < 3; repeat++) {
    if (variant === 'cache-miss') {
      // Only the explicitly selected, locally signed fixture installation.
      adb('shell', 'pm', 'clear', 'app.usebeeline');
      open('review/transcript-fixture-local-only-36bbb7b4');
      let ready = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        await pause(1000);
        adb('shell', 'rm', '-f', '/sdcard/transcript-ready.xml');
        adb('shell', 'uiautomator', 'dump', '/sdcard/transcript-ready.xml');
        const xml = adb('shell', 'cat', '/sdcard/transcript-ready.xml');
        if (xml.includes('content-desc="all conversations"')) { ready = true; break; }
      }
      if (!ready) throw new Error('Local review sign-in did not reach the Room list');
      await pause(1500);
    } else {
      open(`beeline/chat/${rooms[1]}?communityId=${workspace}`); await pause(2500);
      if (variant === 'cold-process-retained-cache') adb('shell', 'am', 'force-stop', 'app.usebeeline');
    }
    adb('logcat', '-c');
    const startMs = Number(adb('shell', 'date', '+%s%3N').trim());
    open(`beeline/chat/${rooms[0]}?communityId=${workspace}`);
    await pause(6000);
    const log = adb('logcat', '-d', '-v', 'epoch', '-s', 'ReactNativeJS:V');
    await writeFile(`${output}/${variant}-${repeat}.log`, log);
    const marks = log.split('\n').flatMap(line => {
      const time = line.match(/^\s*(\d{10}\.\d+)/), mark = line.match(/\[ROOM_OPEN\]\s*(\{.*\})/);
      return time && mark ? [{ atMs: Number(time[1]) * 1000, ...JSON.parse(mark[1]) }] : [];
    });
    const frame = marks.find(mark => mark.phase === 'newest-frame');
    samples.push({ variant, repeat, startMs, firstFrameMarkerMs: frame ? frame.atMs - startMs : null,
      timedOut: !frame, marks });
    console.log(variant, samples.at(-1).firstFrameMarkerMs);
  }
}
const before = adb('shell', 'dumpsys', 'meminfo', 'app.usebeeline');
for (let i = 0; i < 20; i++) { open(`beeline/chat/${rooms[i % 2]}?communityId=${workspace}`); await pause(1000); }
const after = adb('shell', 'dumpsys', 'meminfo', 'app.usebeeline');
await writeFile(`${output}/capture.json`, JSON.stringify({ device, samples, memory: { switches: 20, before, after },
  method: 'Device epoch launch to existing release newest-frame marker; log timestamp includes delivery latency, not a physical scanout timestamp.',
  settledTranscript: null }, null, 2));
