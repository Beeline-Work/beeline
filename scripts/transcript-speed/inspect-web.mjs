const webOrigin = process.env.TRANSCRIPT_WEB_ORIGIN ?? 'http://127.0.0.1:19882';
const viewport = { width: Number(process.env.TRANSCRIPT_WEB_WIDTH ?? 390), height: 844 };
import { rooms, workspace } from './fixture.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/home/lunchbox/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: viewport });
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  page.on('requestfailed', request => console.log('REQUEST FAILED', request.url(), request.failure()));
  page.on('response', response => { if (response.status() >= 400) console.log('HTTP ERROR', response.status(), response.url()); });
  await page.goto(`${webOrigin}/review/transcript-fixture-local-only-36bbb7b4`);
  await page.waitForURL('**/beeline/channels**');
  await page.goto(`${webOrigin}/beeline/chat/${rooms[0]}?communityId=${workspace}`);
  await page.getByText('Fixture 0999: agent answer', { exact: false }).first().waitFor({ timeout: 30000 });
  const transcriptBox = await page.getByTestId('chat-messages').boundingBox();
  if (!transcriptBox || transcriptBox.height <= 0 || transcriptBox.height > viewport.height)
    throw new Error('Transcript viewport escaped the application layout');
  console.log('transcript viewport', transcriptBox);
  await page.screenshot({ path: '/tmp/transcript-web-36bbb7b4.png' });
  console.log((await page.locator('body').innerText()).slice(-2000));
  console.log('instrumentation', await page.evaluate(() => typeof globalThis.__transcriptSpeed));
} finally { await browser.close(); }
