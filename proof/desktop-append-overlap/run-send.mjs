// Measure each adjacent row and the newest row after consecutive sends.
// The first send starts while the reader is scrolled into history.
const { chromium } = await import(
  process.env.PLAYWRIGHT_CORE_PATH ?? '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs'
);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ??
    '/home/lunchbox/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto('file://' + process.cwd() + '/proof/desktop-append-overlap/index.html?count=60');
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
  await page.evaluate(() => window.__goTop());
  for (let send = 1; send <= 5; send++) {
    await page.evaluate(() => window.__sendOne());
    await page.waitForTimeout(200);
    const bounds = await page.evaluate((label) => {
      window.__measure(label);
      return JSON.parse(document.getElementById('log').textContent.trim().split('\n').at(-1));
    }, `send ${send}`);
    console.log(JSON.stringify({
      send,
      tailGap: bounds.tailGap,
      previousRowBounds: bounds.previousRowBounds,
      newestRowBounds: bounds.newestRowBounds,
      minimumRowGap: bounds.minimumRowGap,
      overlaps: bounds.overlaps,
      newestRowVisible: bounds.newestRowVisible,
    }));
    if (bounds.overlaps || bounds.minimumRowGap < -0.5 ||
        !bounds.newestRowVisible || bounds.tailGap > 1) process.exitCode = 1;
  }
  await page.close();
} finally {
  await browser.close();
}
