// Drives the repro page with the playwright-core already on this host and
// prints the page's own measured verdict lines. Run:
//   node proof/desktop-append-overlap/run.mjs
import { chromium } from '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs';

const executablePath =
  '/home/lunchbox/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[repro]')) console.log('console:', t);
});
page.on('pageerror', (e) => console.log('pageerror:', String(e)));
await page.goto('file://' + process.cwd() + '/proof/desktop-append-overlap/index.html');
await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', null, {
  timeout: 20000,
});
const readLog = () => page.evaluate(() => document.getElementById('log').textContent);
console.log('--- cold open ---');
console.log(await readLog());
console.log('--- append one (the reported case) ---');
await page.evaluate(() => window.__appendOne());
await page.waitForTimeout(120);
console.log(await readLog());
await page.waitForTimeout(250);
await page.evaluate(() => window.__measure('after-append+420ms'));
console.log(await readLog());
// Second append to confirm the pattern repeats.
await page.evaluate(() => window.__appendOne());
await page.waitForTimeout(420);
console.log('--- second append ---');
console.log(await readLog());
await browser.close();
