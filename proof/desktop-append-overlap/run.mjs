// Drives the repro page with the playwright-core already on this host and
// prints the page's own measured verdict lines. The command FAILS (exit 1)
// when the verdict is false: the newest appended row is not fully on screen
// or any two row rects overlap. Usage:
//   node proof/desktop-append-overlap/run.mjs [count] [appends] [nofix] [reps]
// `reps` runs fresh page loads and fails if any rep fails.
const [countArg = '60', appendsArg = '1', nofixArg = '', repsArg = '1'] = process.argv.slice(2);
const playwrightCorePath =
  process.env.PLAYWRIGHT_CORE_PATH ??
  '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs';
const executablePath =
  process.env.CHROMIUM_PATH ??
  '/home/lunchbox/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const { chromium } = await import(playwrightCorePath);
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });

const runOnce = async (rep) => {
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
  // A long transcript converges through many measured windows; give it the
  // five-second window the review round used before reporting.
  await page.waitForTimeout(Number(countArg) >= 200 ? 5000 : 1600);
  await page.evaluate((label) => window.__measure(label), `after ${appendsArg} append(s)`);
  const last = await page.evaluate(() => {
    const lines = document.getElementById('log').textContent.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  });
  const ok = last.newestRowVisible === true && last.overlaps === 0;
  console.log(
    `count=${countArg} appends=${appendsArg} ${nofixArg ? 'NOFIX' : 'FIX  '} rep=${rep} -> ` +
      `tailGap ${last.tailGap} newestRowVisible ${last.newestRowVisible} overlaps ${last.overlaps} ` +
      `budgetLeft ${last.budgetLeft} ${ok ? 'PASS' : 'FAIL'}`,
  );
  await page.close();
  return ok;
};

let allOk = true;
for (let rep = 1; rep <= Number(repsArg); rep++) {
  if (!(await runOnce(rep))) allOk = false;
}
await browser.close();
if (!allOk) process.exitCode = 1;
