import { chromium } from '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs';
const executablePath =
  '/home/lunchbox/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.goto('file://' + process.cwd() + '/proof/desktop-append-overlap/index.html');
await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', null, { timeout: 20000 });
// Rapid appends: three messages while the tail window is unmeasured.
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => window.__appendOne());
  await page.waitForTimeout(60);
}
await page.waitForTimeout(400);
const verdict = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-row]'));
  const rects = rows.map((r) => r.getBoundingClientRect());
  let overlaps = 0; const details = [];
  for (let i = 1; i < rects.length; i++) {
    if (rects[i].top < rects[i - 1].bottom - 0.5) {
      overlaps++;
      details.push(`row${i}.top=${rects[i].top.toFixed(1)} < row${i-1}.bottom=${rects[i-1].bottom.toFixed(1)}`);
    }
  }
  const sc = document.querySelector('[data-testid="chat-messages"]');
  const gap = sc ? sc.scrollHeight - sc.clientHeight - sc.scrollTop : null;
  return { rows: rows.length, overlaps, details: details.slice(0, 8), tailGap: gap, bottomRowVisible: rects.length ? rects[rects.length-1].bottom <= window.innerHeight : null };
});
console.log(JSON.stringify(verdict, null, 1));
await page.screenshot({ path: 'proof/desktop-append-overlap/after-append.png', fullPage: false });
await browser.close();
