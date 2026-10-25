/** STREAM-CLIP-1: retain ten midpoint snapshots of the real two-agent live path. */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fixtureStimulus } from './stimulus.mjs';
import { corner, rooms, workspace, fixtureFingerprint } from './fixture.mjs';
import { androidArtifact } from './android-artifact.mjs';

const device = process.env.LATENCY_RIG_DEVICE;
if (!/^(emulator-\d+|127\.0\.0\.1:\d+)$/.test(device ?? ''))
  throw new Error('Select the owned fixture emulator with LATENCY_RIG_DEVICE');
const output = process.argv[2];
if (!output) throw new Error('Supply an evidence directory');
const adb = (...args) => execFileSync('adb', ['-s', device, ...args], {
  encoding: 'utf8', maxBuffer: 32e6,
});
if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1')
  throw new Error('Disposable emulator required');
await mkdir(output, { recursive: true });
const artifact = androidArtifact(adb);
const stimulus = await fixtureStimulus();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cold = process.env.TRANSCRIPT_STREAM_COLD !== '0';
const trials = [];
const open = room => adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d',
  `beeline://beeline/chat/${room}?communityId=${workspace}`, 'app.usebeeline/.MainActivity');
try {
  for (let trial = 0; trial < 10; trial++) {
    if (cold) adb('shell', 'am', 'force-stop', 'app.usebeeline');
    else { open(rooms[0]); await pause(1200); }
    open(corner);
    await pause(2500);
    await stimulus.stream(async () => {
      const screenshot = `${output}/stream-${trial}.png`;
      await writeFile(screenshot, execFileSync('adb', ['-s', device, 'exec-out', 'screencap', '-p']));
      const ocr = execFileSync('tesseract', [screenshot, 'stdout'], { encoding: 'utf8' });
      await writeFile(`${output}/stream-${trial}.txt`, ocr);
      const both = /Stream [0O]:/.test(ocr) && /Stream 1:/.test(ocr);
      trials.push({ trial, both, at: new Date().toISOString(), screenshot });
      console.log(JSON.stringify(trials.at(-1)));
    });
    await writeFile(`${output}/results.json`, JSON.stringify({
      reproduction: 'STREAM-CLIP-1', cold, fixtureFingerprint, ...artifact, trials,
    }, null, 2));
    await pause(1000);
  }
} finally { await stimulus.close(); }
if (trials.some(trial => !trial.both) && process.env.TRANSCRIPT_EXPERIMENT_KEEP_FAILURES !== '1')
  process.exitCode = 1;
