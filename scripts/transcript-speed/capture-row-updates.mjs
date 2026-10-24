/** Visible Android regression proof for row memoization; disposable fixture only. */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { startControl } from './control.mjs';
import { androidArtifact } from './android-artifact.mjs';
import { fixtureStimulus } from './stimulus.mjs';
import { localDatabase, rooms, workspace, agents } from './fixture.mjs';
import { summarize } from './metrics.mjs';
import { pointFor } from '../latency-rig/capture-ui.mjs';

const device = process.env.LATENCY_RIG_DEVICE;
if (!/^(emulator-\d+|127\.0\.0\.1:\d+)$/.test(device ?? '')) throw new Error('Select the owned fixture emulator');
const output = process.argv[2];
if (!output) throw new Error('Supply an evidence directory');
await mkdir(output, { recursive: true });
const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8', maxBuffer: 32e6 });
if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') throw new Error('Disposable emulator required');
const artifact = androidArtifact(adb);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const dump = () => {
  adb('shell', 'uiautomator', 'dump', '/sdcard/row-updates.xml');
  return adb('shell', 'cat', '/sdcard/row-updates.xml');
};
const tap = point => {
  if (!point) throw new Error('Expected visible control missing');
  adb('shell', 'input', 'tap', ...point.map(String));
};
const control = startControl();
const stimulus = await fixtureStimulus();
const db = new pg.Client({ connectionString: localDatabase(process.env.LATENCY_RIG_DATABASE_URL) });
await db.connect();
const proof = { device, ...artifact, samples: [] };
async function capture(name, action) {
  const sample = await control.capture(name, 2500, action);
  const result = { ...summarize(sample, 60), raw: sample };
  proof.samples.push(result);
  return result;
}
function requireVisible(xml, text) {
  if (!xml.includes(text)) throw new Error(`Visible result missing: ${text}`);
}
async function screenshot(name) {
  await writeFile(`${output}/${name}.png`, execFileSync('adb', ['-s', device, 'exec-out', 'screencap', '-p']));
}
try {
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d',
    `beeline://beeline/chat/${rooms[0]}?communityId=${workspace}`, 'app.usebeeline/.MainActivity');
  await pause(2000);
  await control.ready();
  const jumpLabel = [...dump().matchAll(/content-desc="([^"]*)"/g)].map(match => match[1]).find(label => label.endsWith('Jump to newest message'));
  if (jumpLabel) { tap(pointFor(dump(), 'content-desc', jumpLabel)); await pause(1500); }
  let incoming;
  await capture('incoming-risk', async () => { incoming = await stimulus.incoming(); });
  requireVisible(dump(), incoming.text);
  const edited = `Edited row ${incoming.id.slice(0, 12)}`;
  await capture('edit-risk', async () => {
    await db.query('UPDATE messages SET text=$1 WHERE id=$2', [edited, incoming.id]);
  });
  requireVisible(dump(), edited);
  await capture('reaction-risk', async () => {
    await db.query('UPDATE messages SET reactions=$1 WHERE id=$2', [JSON.stringify({ '👍': [agents[0]] }), incoming.id]);
  });
  requireVisible(dump(), '👍, 1 reaction');
  await capture('reaction-toggle-risk', async () => { tap(pointFor(dump(), 'content-desc', '👍, 1 reaction')); });
  requireVisible(dump(), '👍, 2 reactions');
  proof.editsAndReactionsVisible = true;
  await screenshot('edited-and-reacted');
  const restingComposer = pointFor(dump(), 'content-desc', 'Message');
  tap(restingComposer);
  await pause(1000);
  const raisedComposer = pointFor(dump(), 'content-desc', 'Message');
  if (!restingComposer || !raisedComposer || raisedComposer[1] >= restingComposer[1] - 100) throw new Error('Composer did not dock above the keyboard');
  const typing = await capture('typing-risk', async () => { adb('shell', 'input', 'text', 'draftregression'); });
  requireVisible(dump(), 'draftregression');
  if (typing.rowCommits !== 0) throw new Error(`Typing committed ${typing.rowCommits} transcript rows`);
  await screenshot('keyboard-dock');
  adb('shell', 'input', 'keyevent', '4');
  await pause(500);
  const restoredComposer = pointFor(dump(), 'content-desc', 'Message');
  if (!restoredComposer || Math.abs(restoredComposer[1] - restingComposer[1]) > 3) throw new Error('Composer did not return after keyboard dismissal');
  proof.keyboardDock = { restingComposer, raisedComposer, restoredComposer };
  adb('shell', 'input', 'swipe', '500', '650', '500', '1900', '500');
  await pause(1000);
  const beforeScroll = dump();
  const anchor = [...beforeScroll.matchAll(/<node\b[^>]*>/g)].map(match => match[0])
    .find(node => /text="Fixture \d{4}/.test(node) && !node.includes('bounds="[0,0][0,0]"'));
  const anchorText = anchor?.match(/text="([^"]*)"/)?.[1];
  const beforePoint = anchorText && pointFor(beforeScroll, 'text', anchorText);
  if (!beforePoint) throw new Error('Older visible scroll anchor missing');
  await stimulus.incoming();
  await pause(2000);
  const afterPoint = pointFor(dump(), 'text', anchorText);
  if (!afterPoint || Math.abs(afterPoint[1] - beforePoint[1]) > 3) throw new Error('Incoming message moved the reading position');
  proof.scrollAnchor = { anchorText, beforePoint, afterPoint };
  await screenshot('reading-position');
  proof.status = 'passed';
} finally {
  await writeFile(`${output}/capture.json`, JSON.stringify(proof, null, 2));
  control.close();
  await stimulus.close();
  await db.end();
}
console.log('Visible edits, reactions, typing, keyboard dock and reading position passed.');
