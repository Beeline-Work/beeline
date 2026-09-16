// Drives the repro page with the playwright-core already on this host and
// prints the page's own measured verdict lines. Usage:
//   node proof/desktop-append-overlap/run.mjs [count] [appends] [nofix]
const [countArg = '60', appendsArg = '1', nofixArg = ''] = process.argv.slice(2);
const playwrightCorePath =
  process.env.PLAYWRIGHT_CORE_PATH ??
  '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs';
const executablePath =
  process.env.CHROMIUM_PATH ??
  '/home/lunchbox/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const { chromium } = await import(playwrightCorePath);
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const query = new URLSearchParams({ count: countArg });
if (nofixArg) query.set('nofix', '');
await page.goto(
  'file://' + process.cwd() + '/proof/desktop-append-overlap/index.html' + `?${query.toString()}`,
);
await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', null, {
  timeout: 20000,
});
for (let i = 0; i < Number(appendsArg); i++) {
  await page.evaluate(() => window.__appendOne());
  await page.waitForTimeout(60);
}
await page.waitForTimeout(1600);
await page.evaluate((label) => window.__measure(label), `after ${appendsArg} append(s)`);
const last = await page.evaluate(() => {
  const lines = document.getElementById('log').textContent.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
});
console.log(
  `count=${countArg} appends=${appendsArg} ${nofixArg ? 'NOFIX' : 'FIX  '} -> ` +
    `tailGap ${last.tailGap} newestRowVisible ${last.newestRowVisible} overlaps ${last.overlaps} budgetLeft ${last.budgetLeft}`,
);
await browser.close();
