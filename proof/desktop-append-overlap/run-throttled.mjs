// CPU-throttled long-transcript run: the review round's five-second 500-row
// protocol under load (Chrome DevTools CPU throttling), where the default
// 10-cells-per-commit fill walk was measured to still be mid-walk five
// seconds after one append. Fails (exit 1) on a false verdict, like run.mjs.
// Usage:
//   node proof/desktop-append-overlap/run-throttled.mjs [count] [reps] [rate]
const [countArg = '500', repsArg = '6', rateArg = '6'] = process.argv.slice(2);
const playwrightCorePath =
  process.env.PLAYWRIGHT_CORE_PATH ??
  '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs';
const executablePath =
  process.env.CHROMIUM_PATH ??
  '/home/lunchbox/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const { chromium } = await import(playwrightCorePath);
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });

const runOnce = async (rep) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: Number(rateArg) });
  await page.goto(
    'file://' + process.cwd() + '/proof/desktop-append-overlap/index.html?count=' + countArg,
  );
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent === 'ready',
    null,
    { timeout: 60000 },
  );
  await page.evaluate(() => window.__appendOne());
  await page.waitForTimeout(5000);
  await page.evaluate((label) => window.__measure(label), `throttled-${rep}`);
  const last = await page.evaluate(() => {
    const lines = document.getElementById('log').textContent.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  });
  const ok = last.newestRowVisible === true && last.overlaps === 0;
  console.log(
    `count=${countArg} rate=${rateArg}x rep=${rep} -> ` +
      `tailGap ${last.tailGap} newestRowVisible ${last.newestRowVisible} overlaps ${last.overlaps} ` +
      `budgetLeft ${last.budgetLeft} ${ok ? 'PASS' : 'FAIL'}`,
  );
  await context.close();
  return ok;
};

let allOk = true;
for (let rep = 1; rep <= Number(repsArg); rep++) {
  if (!(await runOnce(rep))) allOk = false;
}
await browser.close();
if (!allOk) process.exitCode = 1;
