import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { rooms, workspace, corner, fixtureFingerprint } from './fixture.mjs';
import { fixtureStimulus } from './stimulus.mjs';
import { summarize } from './metrics.mjs';
import { desktopMemory } from './process-memory.mjs';
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
    const eventTimingSupported = await evaluate(`globalThis.__keyPaintEvents=[]; globalThis.__keyPaintBounds=[];
      if (!globalThis.__keyPaintListener) { globalThis.__keyPaintListener=true;
        addEventListener('keydown', event=>{if(!event.isTrusted || event.key.length!==1)return;
          const startTime=performance.now(); requestAnimationFrame(()=>requestAnimationFrame(()=>globalThis.__keyPaintBounds.push({startTime,duration:performance.now()-startTime})));},true); }

      if (!PerformanceObserver.supportedEntryTypes.includes('event')) return false;
      new PerformanceObserver(list=>{for(const event of list.getEntries()) if(event.name==='keydown')
        globalThis.__keyPaintEvents.push({duration:event.duration,startTime:event.startTime});
      }).observe({type:'event',durationThreshold:16}); return true;`);
    for (const character of 'measure') {
      await capture('keystroke', async () => { await call(`element/${input}/value`, { text: character }); await pause(150); });
    }
    samples.at(-1).keyPaintUpperBounds = await evaluate('return globalThis.__keyPaintBounds');
    samples.at(-1).keyPaintSupported = eventTimingSupported;
    samples.at(-1).keyPaintEvents = await evaluate('return globalThis.__keyPaintEvents');
    await clear(input);
    const scrollBefore = await evaluate('return Array.from(document.querySelectorAll("*")).filter(e=>e.scrollHeight>e.clientHeight).map(e=>e.scrollTop)');
    await capture('scroll', async () => {
      execFileSync('xdotool', ['mousemove', '850', '400'], { env: { ...process.env, DISPLAY: ':91' } });
      for (let i = 0; i < 10; i++) {
        execFileSync('xdotool', ['click', '4'], { env: { ...process.env, DISPLAY: ':91' } }); await pause(100);
      }
    });
    const scrollAfter = await evaluate('return Array.from(document.querySelectorAll("*")).filter(e=>e.scrollHeight>e.clientHeight).map(e=>e.scrollTop)');
    samples.at(-1).scrollChanged = JSON.stringify(scrollBefore) !== JSON.stringify(scrollAfter);
    await capture('fling', async () => {
      // A decaying wheel burst is the repeatable desktop fling equivalent.
      for (const clicks of [12, 8, 4, 2, 1]) {
        execFileSync('xdotool', ['click', '--repeat', String(clicks), '--delay', '15', '4'], { env: { ...process.env, DISPLAY: ':91' } });
      }
      await pause(1200);
    });
    const oldest = async () => Math.min(...Array.from((await text()).matchAll(/Fixture (\d{4})/g), m => Number(m[1])));
    const oldestBefore = await oldest();
    await capture('history-prepend', async () => {
      for (let i = 0; i < 60 && await oldest() >= oldestBefore; i++) {
        // Native pointer input establishes reader intent before reaching the top.
        execFileSync('xdotool', ['click', '--repeat', '12', '--delay', '10', '4'], { env: { ...process.env, DISPLAY: ':91' } });
        await evaluate(`const list=document.querySelector('[data-testid="chat-messages"]'); list.scrollTop=0;`);
        await pause(200);
      }
    });
    samples.at(-1).history = { oldestBefore, oldestAfter: await oldest() };
    if (!(samples.at(-1).history.oldestAfter < oldestBefore)) throw new Error('Desktop history gesture did not reveal an older fixture row');
    await open(rooms[0]); await pause(2000);
    let incoming;
    await capture('incoming', async () => { incoming = await stimulus.incoming(); await pause(1500); });
    samples.at(-1).presentInDocument = (await text()).includes(incoming.text);
    if (!samples.at(-1).presentInDocument) throw new Error('Desktop incoming message did not render');
    await open(corner); await pause(2000);
    let streamObserved = false;
    await capture('concurrent-streams', async () => {
      const streaming = stimulus.stream();
      await pause(1500); streamObserved = (await text()).includes('Stream 0:') && (await text()).includes('Stream 1:');
      await streaming;
    });
    samples.at(-1).bothStreamsObserved = streamObserved;
    if (!streamObserved) throw new Error('Desktop did not display both streams');
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
    if (!samples.at(-1).serverSettled) throw new Error('Desktop optimistic send did not settle');
  }
  for (let repeat = 0; repeat < 3; repeat++) {
  const memoryBeforeSwitches = desktopMemory();
  await capture('warm-room-switches', async () => {
    for (let i = 0; i < 20; i++) {
      const target = await element(`[data-testid="desktop-room-${rooms[i % 2]}"]`);
      await call(`element/${target}/click`, {});
      await pause(1000);
      if (!(await evaluate('return location.pathname')).includes(rooms[i % 2])) throw new Error('Desktop Room switch did not navigate');
    }
  });
  samples.at(-1).switches = 20;
  samples.at(-1).memory = { before: memoryBeforeSwitches, after: desktopMemory() };
  }
  const screenshot = await call('screenshot', undefined, 'GET');
  await writeFile(`${output}/screen.png`, Buffer.from(screenshot, 'base64'));
  const artifact = '.beeline-cargo-target/release/bundle/deb/Beeline_0.2.20_amd64.deb';
  await writeFile(`${output}/capture.json`, JSON.stringify({ status: 'partial', platform: 'packaged-tauri', fixtureFingerprint,
    artifactSha256: createHash('sha256').update(await readFile(artifact)).digest('hex'),
    checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runtime: await evaluate('return navigator.userAgent'), refreshHz: 60,
    device: `${os.hostname()} ${os.cpus()[0]?.model}`,
    display: 'Xvfb :91 1280x840; software rendering; virtual cadence',
    profilingOverhead: 'unmeasured', uiFrames: null, blankArea: null, keystrokeToPaint: null, samples }, null, 2));
} finally { await stimulus.close(); }
