const repeatCount = Number(process.env.TRANSCRIPT_REPEAT_COUNT ?? 3);
if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 3) throw new Error('TRANSCRIPT_REPEAT_COUNT must be from 1 to 3');
const webOrigin = process.env.TRANSCRIPT_WEB_ORIGIN ?? 'http://127.0.0.1:19882';
const viewport = { width: Number(process.env.TRANSCRIPT_WEB_WIDTH ?? 390), height: 844 };
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { rooms, workspace } from './fixture.mjs';
let desktop = process.env.TRANSCRIPT_WEBDRIVER_SESSION;
const output = process.argv[2] ?? '/tmp/transcript-browser-opens';
await mkdir(output, { recursive: true });
let browser, context, page, chromium;
const launchOptions = { executablePath: process.env.CHROMIUM_PATH ?? '/home/lunchbox/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] };
const base = desktop ? 'tauri://localhost' : webOrigin;
async function wd(path, body) {
  const response = await fetch(`http://127.0.0.1:19885/session/${desktop}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json(); if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result));
  return result.value;
}
const evaluate = (script, ...args) => desktop ? wd('execute/sync', { script, args })
  : page.evaluate(({ script, args }) => Function(script).apply(null, args), { script, args });
const navigate = url => desktop ? wd('url', { url }) : page.goto(url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const route = room => `${base}/beeline/chat/${room}?communityId=${workspace}`;
const ready = async room => {
  for (let i = 0; i < 100; i++) {
    if (await evaluate('return location.pathname.includes(arguments[0]) && !!document.querySelector("textarea[aria-label=Message]") && document.body.innerText.includes("Fixture")', room)) return;
    await pause(100);
  }
  throw new Error('Fixture Room content did not become visible');
};
async function signIn() {
  await navigate(`${base}/review/transcript-fixture-local-only-36bbb7b4`);
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`return location.pathname.includes('channels') && !!document.querySelector('[aria-label="all conversations"]')`)) return;
    await pause(100);
  }
  throw new Error('Local sign-in did not reach the Room list');
}
async function warm(room) {
  if (!desktop && await page.getByRole('button', { name: 'Back to Rooms', exact: true }).count())
    await page.getByRole('button', { name: 'Back to Rooms', exact: true }).click();
  const selector = `[data-testid="${desktop || viewport.width >= 1024 ? 'desktop-room-' : 'room-'}${room}"]`;
  if (desktop) {
    const element = await wd('element', { using: 'css selector', value: selector });
    await wd(`element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
  } else await page.locator(selector).click();
}
const samples = [];
try {
  if (!desktop) {
    ({ chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs'));
    browser = await chromium.launch(launchOptions);
    context = await browser.newContext({ viewport: viewport }); page = await context.newPage();
    await signIn();
  }
  await navigate(route(rooms[0])); await ready(rooms[0]);
  for (const variant of ['cold-process-retained-storage', 'warm', 'cache-miss']) {
    for (let repeat = 0; repeat < repeatCount; repeat++) {
      if (variant === 'cache-miss') {
        if (!desktop) {
          await context.close(); context = await browser.newContext({ viewport: viewport }); page = await context.newPage();
        } else {
          // Unload the application before deleting its fixture-origin stores.
          await navigate(`${base}/favicon.ico`);
          const cleared = await wd('execute/async', { script: `const done=arguments[arguments.length-1]; localStorage.clear();
            (async()=>{for(const db of await indexedDB.databases()) await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(db.name);r.onsuccess=resolve;r.onerror=reject;r.onblocked=()=>reject(new Error('Fixture database is open'));});})().then(()=>done(true),e=>done({error:String(e)}));`, args: [] });
          if (cleared !== true) throw new Error(`Desktop fixture cache clear failed: ${JSON.stringify(cleared)}`);
        }
        await signIn();
      } else { await navigate(route(rooms[1])); await ready(rooms[1]); await pause(1000); }
      let start = performance.now();
      if (variant === 'cold-process-retained-storage') {
        if (desktop) {
          await fetch(`http://127.0.0.1:19885/session/${desktop}`, { method: 'DELETE' });
          start = performance.now();
          const response = await fetch('http://127.0.0.1:19885/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ capabilities: { alwaysMatch: { 'tauri:options': { application: process.env.TRANSCRIPT_DESKTOP_BINARY ?? '/tmp/transcript-desktop-package/usr/bin/beeline-desktop' } } } }) });
          const result = await response.json();
          if (!response.ok || !result.value?.sessionId) throw new Error(JSON.stringify(result));
          desktop = result.value.sessionId;
        } else {
          const storageState = await context.storageState({ indexedDB: true });
          await browser.close();
          start = performance.now();
          browser = await chromium.launch(launchOptions);
          context = await browser.newContext({ viewport: viewport, storageState });
          page = await context.newPage();
        }
      }
      if (variant === 'warm') await warm(rooms[0]); else await navigate(route(rooms[0]));
      await ready(rooms[0]);
      if (desktop) await wd('execute/async', { script: 'const done=arguments[arguments.length-1]; requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)))', args: [] });
      else await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const firstVisibleUpperBoundMs = performance.now() - start;
      let previous = '', quiet = 0, settledUpperBoundMs = null;
      for (let poll = 0; poll < 100; poll++) {
        await pause(100);
        const snapshot = await evaluate('return JSON.stringify([document.body.innerText,document.body.scrollHeight,Array.from(document.images).map(i=>[i.complete,i.naturalWidth,i.naturalHeight])])');
        quiet = snapshot === previous ? quiet + 1 : 0; previous = snapshot;
        if (quiet >= 5) { settledUpperBoundMs = performance.now() - start; break; }
      }
      samples.push({ variant, repeat, firstVisibleUpperBoundMs, settledUpperBoundMs });
      console.log(variant, Math.round(firstVisibleUpperBoundMs));
    }
  }
  await writeFile(`${output}/capture.json`, JSON.stringify({ platform: desktop ? 'packaged-tauri' : viewport.width >= 1024 ? 'desktop-web' : 'narrow-web', samples,
    method: 'External action to observed fixture DOM plus two animation frames; upper bound includes driver round trips and 100ms readiness polling, not a physical scanout timestamp. Settled means five unchanged text/image-state polls.',
    coldDefinition: 'new browser/app process with retained fixture storage; OS disk cache is not flushed', finalDesktopSession: desktop ?? null }, null, 2));
} finally { if (browser) await browser.close(); }
