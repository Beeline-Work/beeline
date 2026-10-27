// Reproduction R1 browser stand-in. Install playwright-core into a temporary
// prefix and point CORNER_SWIPE_PLAYWRIGHT at its index.mjs; serve
// .verification/corner-swipe-rest on 127.0.0.1:18492.
// Android lost the off-screen translation Swipeable hides its panels with; the
// page drops that translation the same way, then checks what paints at rest.
import path from 'node:path';
const { chromium } = await import(process.env.CORNER_SWIPE_PLAYWRIGHT ?? 'playwright-core');
const out = path.resolve(process.argv[2] ?? 'apps/mobile/evidence/corner-swipe-rest');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const orientations = { landscape: { width: 851, height: 393 }, portrait: { width: 393, height: 851 } };
let failed = false;
try {
  for (const phase of ['before', 'after']) {
    for (const [orientation, viewport] of Object.entries(orientations)) {
      // 2.75 device pixels per point: 2340x1080 landscape, 1080x2340 portrait.
      const page = await browser.newPage({ viewport, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:18492/${phase}/?theme=bone`);
      await page.getByText('Ruby', { exact: true }).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const result = await page.evaluate(() => {
        const panels = [...document.querySelectorAll('[data-testid^="corner-swipe-action-"],[data-testid^="reply-swipe-action-"]')];
        for (const panel of panels) panel.parentElement.style.transform = 'none';
        return panels.map((panel) => {
          const id = panel.getAttribute('data-testid');
          const messageId = id.replace(/^(corner|reply)-swipe-action-/, '');
          const body = document.querySelector(`[data-testid="copy-message-${messageId}"]`).getBoundingClientRect();
          const box = panel.getBoundingClientRect();
          const overlaps = box.right > body.left && box.left < body.right && box.bottom > body.top && box.top < body.bottom;
          return { id, painted: getComputedStyle(panel).opacity !== '0', overlapsMessage: overlaps };
        });
      });
      const shot = path.join(out, `${phase}-${orientation}.png`);
      await page.screenshot({ path: shot });
      const covering = result.filter((panel) => panel.painted && panel.overlapsMessage).map((panel) => panel.id);
      const pass = covering.length === 0 && errors.length === 0;
      if (phase === 'after' && !pass) failed = true;
      console.log(`R1 ${phase} ${orientation}: ${pass ? 'PASS no panel painted over message text' : `WRONG panels painted over text: ${covering.join(', ')}`}${errors.length ? ` errors: ${errors.join('; ')}` : ''}`);
      await page.close();
    }
  }
} finally { await browser.close(); }
if (failed) process.exit(1);
