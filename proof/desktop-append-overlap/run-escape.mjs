// Drives the reader-escape scenario: one append arms the tail follow, the
// reader leaves for history WITHOUT any wheel/touch event (the scrollbar
// drag / PageUp shape), an older page prepends, and we report whether the
// follow yanked them back to the bottom. Usage:
//   node proof/desktop-append-overlap/run-escape.mjs [count] [early|late] [flags: nofix noguard]
//   early — escape lands inside the settle window, while the follow may
//           still hold budget (this is the shape finding 2 convicts);
//   late  — escape lands after the settle window disarmed the follow.
const [countArg = '30', phaseArg = 'early', ...flags] = process.argv.slice(2);
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
for (const flag of flags) query.set(flag, '');
await page.goto(
  'file://' + process.cwd() + '/proof/desktop-append-overlap/index.html' + `?${query.toString()}`,
);
await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', null, {
  timeout: 20000,
});
await page.evaluate(() => window.__appendOne());
await page.waitForTimeout(phaseArg === 'late' ? 1500 : 250);
await page.evaluate(() => window.__goTop());
await page.waitForTimeout(120);
await page.evaluate(() => window.__prependOlder(12));
await page.waitForTimeout(900);
await page.evaluate((label) => window.__measure(label), `escape-${phaseArg}`);
const last = await page.evaluate(() => {
  const lines = document.getElementById('log').textContent.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
});
console.log(
  `count=${countArg} phase=${phaseArg} ${flags.join(' ') || 'fix'} -> ` +
    `scrollTop ${last.scrollTop} tailGap ${last.tailGap} budgetLeft ${last.budgetLeft} ` +
    `rows ${last.rows}`,
);
await browser.close();
