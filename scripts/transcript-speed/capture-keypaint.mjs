import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pointFor } from '../latency-rig/capture-ui.mjs';
import { rooms, workspace } from './fixture.mjs';
const device = process.env.LATENCY_RIG_DEVICE;
if (!/^emulator-\d+$/.test(device ?? '')) throw new Error('Select a leased fixture emulator');
const output = process.argv[2] ?? '/tmp/transcript-keypaint-results';
await mkdir(output, { recursive: true });
const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8', maxBuffer: 16e6 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d',
  `beeline://beeline/chat/${rooms[0]}?communityId=${workspace}`, 'app.usebeeline/.MainActivity');
await pause(3000);
adb('shell', 'rm', '-f', '/sdcard/transcript-key.xml');
adb('shell', 'uiautomator', 'dump', '/sdcard/transcript-key.xml');
const point = pointFor(adb('shell', 'cat', '/sdcard/transcript-key.xml'), 'content-desc', 'Message');
if (!point) throw new Error('Visible fixture composer missing');
adb('shell', 'input', 'tap', ...point.map(String)); await pause(500);
const samples = [];
for (let repeat = 0; repeat < 21; repeat++) {
  const needle = randomBytes(8).toString('hex');
  adb('shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A');
  adb('shell', 'input', 'keyevent', 'KEYCODE_DEL');
  adb('shell', 'input', 'text', needle.slice(0, -1)); await pause(250);
  adb('logcat', '-c');
  const armed = adb('shell', 'am', 'broadcast', '-a', 'app.usebeeline.LATENCY_RIG_EXPECT', '-n', 'app.usebeeline/.LatencyRigReceiver',
    '--es', 'needle', needle, '--es', 'case', 'keypaint', '--es', 'entry', 'key');
  if (armed.includes('Error')) throw new Error(armed);
  adb('shell', 'input', 'text', needle.slice(-1));
  let result;
  for (let i = 0; i < 20; i++) {
    await pause(100);
    const log = adb('logcat', '-d', '-s', 'LATENCY_NATIVE:W');
    const match = log.match(/LATENCY_VISIBLE (\{.*\})/);
    if (match) { const value = JSON.parse(match[1]); if (value.needle === needle) { result = value; break; } }
  }
  samples.push(result ? { ...result, latencyMs: result.paintMs - result.startMs } : { timedOut: true });
  console.log(repeat, samples.at(-1));
}
await writeFile(`${output}/capture.json`, JSON.stringify({ device, method: 'Activity key-down dispatch to hardware frame commit containing the complete composer text; excludes adb transport and physical panel scanout', samples }, null, 2));
