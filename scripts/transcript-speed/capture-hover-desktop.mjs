/** Hover timing in the extracted packaged Tauri application, using real input. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { rooms, workspace, fixtureFingerprint } from './fixture.mjs';
import { summarize, percentile } from './metrics.mjs';

const output = process.argv[2];
const binary = process.env.TRANSCRIPT_DESKTOP_BINARY;
const packaged = process.env.TRANSCRIPT_DESKTOP_PACKAGE;
const steadyPointer = process.env.TRANSCRIPT_HOVER_STEADY === '1';
const repeatCount = Number(process.env.TRANSCRIPT_REPEAT_COUNT ?? 3);
if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 3) throw new Error('TRANSCRIPT_REPEAT_COUNT must be 1–3');
if (!output || !binary || !packaged) throw new Error('Supply output, TRANSCRIPT_DESKTOP_BINARY and TRANSCRIPT_DESKTOP_PACKAGE');
const origin = `http://127.0.0.1:${Number(process.env.TRANSCRIPT_WEBDRIVER_PORT ?? 20085)}`;
await mkdir(output, { recursive: true });
async function request(route, value, method = 'POST') {
  const response = await fetch(`${origin}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const body = await response.json();
  if (!response.ok || body.value?.error) throw new Error(JSON.stringify(body.value));
  return body.value;
}
const session = await request('/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: binary } } } });
const call = (route, value, method) => request(`/session/${session.sessionId}/${route}`, value, method);
const evaluate = (script, ...args) => call('execute/sync', { script, args });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const move = point => call('actions', { actions: [{ type: 'pointer', id: 'hover-mouse', parameters: { pointerType: 'mouse' },
  actions: [{ type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(point.x), y: Math.round(point.y) }] }] });
const waitFor = async script => {
  for (let attempt = 0; attempt < 120; attempt++) { if (await evaluate(script)) return; await pause(250); }
  throw new Error('Packaged fixture did not become ready');
};
try {
  await call('url', { url: 'tauri://localhost/review/transcript-fixture-local-only-36bbb7b4' });
  await waitFor('return location.pathname.includes("beeline/channels")');
  await call('url', { url: `tauri://localhost/beeline/chat/${rooms[0]}?communityId=${workspace}` });
  await waitFor('return !!globalThis.__transcriptSpeed && document.body.innerText.includes("Fixture 0999: agent answer")');
  await pause(3000);
  const points = await evaluate(`return Array.from(document.querySelectorAll('[data-testid^="copy-message-"]')).map(row=>{
    const box=row.getBoundingClientRect(),top=Math.max(100,box.top),bottom=Math.min(innerHeight-160,box.bottom);
    return bottom-top>10?{x:box.x+box.width/2,y:(top+bottom)/2,id:row.dataset.testid}:null;
  }).filter(Boolean)`);
  if (!points.length) throw new Error('No visible packaged message row');
  const actions = await evaluate('return document.querySelectorAll(\'[data-testid^="message-actions-"]\').length');
  if (!actions) throw new Error('Packaged desktop action controls are missing');
  if (steadyPointer) {
    const row = points[0];
    points.splice(0, points.length, { ...row, y: row.y - 2 }, { ...row, y: row.y + 2 });
  } else points.push({ x: 10, y: 80, id: 'outside-transcript' });
  await move(points[0]); await pause(300);
  await evaluate(`globalThis.__hoverPaint=[];addEventListener('pointermove',event=>{
    if(!event.isTrusted)return;const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>globalThis.__hoverPaint.push(performance.now()-start)));
  },true)`);
  const samples = [];
  for (let repeat = 0; repeat < repeatCount; repeat++) {
    await evaluate('globalThis.__hoverPaint=[];globalThis.__transcriptSpeed.begin("hover")');
    for (let turn = 0; turn < 30; turn++) { await move(points[turn % points.length]); await pause(75); }
    await pause(100);
    const raw = await evaluate('return globalThis.__transcriptSpeed.end()');
    const paint = await evaluate('return globalThis.__hoverPaint');
    if (!paint.length) throw new Error('WebDriver did not dispatch trusted pointer input');
    samples.push({ repeat, ...summarize(raw, 60), raw, pointerToTwoRafP95Ms: percentile(paint, .95),
      pointerToTwoRafMaxMs: percentile(paint, 1), pointerEvents: paint.length });
  }
  await move(points[0]); await pause(200);
  const visible = await evaluate(`const id=arguments[0].replace('copy-message-','message-actions-');
    const row=document.querySelector('[data-testid="'+id+'"]');return row&&getComputedStyle(row).opacity`, points[0].id);
  if (Number(visible) !== 1) throw new Error('Hovered packaged message actions did not become visible');
  await writeFile(`${output}/hover-active.png`, Buffer.from(await call('screenshot', undefined, 'GET'), 'base64'));
  const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  await writeFile(`${output}/capture.json`, JSON.stringify({ fixtureFingerprint, platform: 'packaged-tauri-webkit',
    binarySha256: await hash(binary), packageSha256: await hash(packaged), steadyPointer, repeatCount, points, actions, hoveredActionsOpacity: visible,
    viewport: await evaluate('return {width:innerWidth,height:innerHeight,userAgent:navigator.userAgent}'), samples,
    note: 'Real pointer trials in the packaged application; repeatCount records the requested count. Pointer to second rAF is a rendering upper bound, not scanout. WebKit cannot supply a Chrome trace; separate Chromium profiles diagnose the shared row implementation.' }, null, 2));
} finally { await request(`/session/${session.sessionId}`, undefined, 'DELETE'); }
