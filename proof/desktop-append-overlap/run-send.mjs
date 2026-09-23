// Measure text and picture sends before and after asynchronous image loading.
// The first send starts while the reader is scrolled into history.
const { chromium } = await import(
  process.env.PLAYWRIGHT_CORE_PATH ?? '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs'
);
const cdpUrl = process.env.CDP_HTTP_URL;
const remoteDebuggerUrl = cdpUrl
  ? (await fetch(`${cdpUrl}/json/version`).then((res) => res.json())).webSocketDebuggerUrl
  : null;
const websocketUrl = remoteDebuggerUrl ? new URL(remoteDebuggerUrl) : null;
if (websocketUrl) websocketUrl.host = new URL(cdpUrl).host;
const browser = cdpUrl
  ? await chromium.connectOverCDP(websocketUrl.href)
  : await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ??
        '/home/lunchbox/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
      headless: true,
      args: ['--no-sandbox'],
    });
try {
  const page = cdpUrl
    ? (browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].newPage())
    : await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(process.env.PROOF_URL ??
    'file://' + process.cwd() + '/proof/desktop-append-overlap/index.html?count=60');
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready');
  await page.evaluate(() => window.__goTop());
  const kinds = ['photo', 'text', 'artifact', 'photo', 'text'];
  for (let send = 1; send <= kinds.length; send++) {
    const kind = kinds[send - 1];
    await page.evaluate((nextKind) => window.__sendOne(nextKind === 'text' ? undefined : nextKind), kind);
    for (const [phase, delay] of [['before-load', 100], ['after-load', 450]]) {
      await page.waitForTimeout(delay);
      const bounds = await page.evaluate((label) => {
        window.__measure(label);
        return JSON.parse(document.getElementById('log').textContent.trim().split('\n').at(-1));
      }, `send ${send} ${phase}`);
      console.log(JSON.stringify({
        send, kind, phase,
        tailGap: bounds.tailGap,
        previousRowBounds: bounds.previousRowBounds,
        newestRowBounds: bounds.newestRowBounds,
        minimumRowGap: bounds.minimumRowGap,
        overlaps: bounds.overlaps,
        imageBounds: bounds.imageBounds,
        newestRowVisible: bounds.newestRowVisible,
      }));
      if (bounds.overlaps || bounds.minimumRowGap < -0.5 ||
          bounds.imageBounds.some((image) => image.outsideRow) ||
          (phase === 'after-load' && bounds.imageBounds.some((image) => !image.loaded)) ||
          !bounds.newestRowVisible || bounds.tailGap > 1) process.exitCode = 1;
    }
  }
  await page.close();
} finally {
  await browser.close();
}
