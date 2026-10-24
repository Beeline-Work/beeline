import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rooms, workspace, corner } from './fixture.mjs';
import { fixtureStimulus } from './stimulus.mjs';
import { summarize } from './metrics.mjs';
const session = process.env.TRANSCRIPT_WEBDRIVER_SESSION;
if (!session) throw new Error('Set TRANSCRIPT_WEBDRIVER_SESSION to the packaged app session');
const output = process.argv[2] ?? '/tmp/transcript-desktop-results';
await mkdir(output, { recursive: true });
async function call(path, value, method = 'POST') {
  const response = await fetch(`http://127.0.0.1:19885/session/${session}/${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const body = await response.json();
  if (!response.ok || body.value?.error) throw new Error(JSON.stringify(body.value));
  return body.value;
}
const evaluate = (script, ...args) => call('execute/sync', { script, args });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const open = async room => {
  await call('url', { url: `tauri://localhost/beeline/chat/${room}?communityId=${workspace}` });
  for (let i = 0; i < 60; i++) {
    if (await evaluate('return !!globalThis.__transcriptSpeed && !!document.querySelector("textarea[aria-label=Message]")')) return;
    await pause(250);
  }
  throw new Error('Packaged Room did not become ready');
};
const element = async selector => {
  const value = await call('element', { using: 'css selector', value: selector });
  return value['element-6066-11e4-a52e-4f735466cecf'];
};
const text = () => evaluate('return document.body.innerText');
const clear = id => call(`element/${id}/value`, { text: '\uE009a\uE000\uE003' });
const samples = [];
const stimulus = await fixtureStimulus();
async function capture(name, action) {
  await evaluate('globalThis.__transcriptSpeed.begin(arguments[0])', name);
  await action();
  await pause(500);
  const raw = await evaluate('return globalThis.__transcriptSpeed.end()');
  samples.push({ ...summarize(raw, 60), raw });
  await writeFile(`${output}/capture.json`, JSON.stringify({ status: 'partial', samples }, null, 2));
  console.log(name);
}
try {
  await open(rooms[0]); await pause(3000);
  if (!(await text()).includes('Fixture')) throw new Error('Packaged fixture messages are missing');
  for (let repeat = 0; repeat < 3; repeat++) {
    await capture('idle', () => pause(1500));
    const input = await element('textarea[aria-label=Message]');
    await call(`element/${input}/click`, {});
    await clear(input);
    await capture('typing', async () => {
      for (const character of 'measure') { await call(`element/${input}/value`, { text: character }); await pause(150); }
    });
    await clear(input);
    await capture('wheel-scroll', async () => {
      execFileSync('xdotool', ['mousemove', '850', '400'], { env: { ...process.env, DISPLAY: ':91' } });
      for (let i = 0; i < 10; i++) {
        execFileSync('xdotool', ['click', '4'], { env: { ...process.env, DISPLAY: ':91' } }); await pause(100);
      }
    });
    await open(rooms[0]); await pause(2000);
    let incoming;
    await capture('incoming', async () => { incoming = await stimulus.incoming(); await pause(1500); });
    samples.at(-1).presentInDocument = (await text()).includes(incoming.text);
    await open(corner); await pause(2000);
    let streamObserved = false;
    await capture('concurrent-streams', async () => {
      const streaming = stimulus.stream();
      await pause(1500); streamObserved = (await text()).includes('Stream 0:') && (await text()).includes('Stream 1:');
      await streaming;
    });
    samples.at(-1).bothStreamsObserved = streamObserved;
    await open(rooms[0]); await pause(1500);
    const sendInput = await element('textarea[aria-label=Message]');
    await clear(sendInput);
    const sent = `Desktop-settlement-${repeat}-${Date.now()}`;
    await call(`element/${sendInput}/value`, { text: sent });
    await capture('optimistic-send', async () => {
      const send = await element('[aria-label="Send message"]');
      await call(`element/${send}/click`, {}); await pause(1500);
    });
    samples.at(-1).serverSettled = await stimulus.settled(sent);
  }
  const screenshot = await call('screenshot', undefined, 'GET');
  await writeFile(`${output}/screen.png`, Buffer.from(screenshot, 'base64'));
  const artifact = '.beeline-cargo-target/release/bundle/deb/Beeline_0.2.20_amd64.deb';
  await writeFile(`${output}/capture.json`, JSON.stringify({ status: 'partial', platform: 'packaged-tauri',
    artifactSha256: createHash('sha256').update(await readFile(artifact)).digest('hex'),
    checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runtime: await evaluate('return navigator.userAgent'), refreshHz: 60,
    display: 'Xvfb :91 1280x840; software rendering; virtual cadence',
    profilingOverhead: 'unmeasured', uiFrames: null, blankArea: null, keystrokeToPaint: null, samples }, null, 2));
} finally { await stimulus.close(); }
