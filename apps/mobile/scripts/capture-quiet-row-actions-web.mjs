// Install playwright-core into a temporary prefix and point QUIET_ACTIONS_PLAYWRIGHT at its index.mjs.
import path from 'node:path';
const { chromium } = await import(process.env.QUIET_ACTIONS_PLAYWRIGHT ?? 'playwright-core');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  for (const theme of ['bone','obsidian']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors=[];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:18491/?theme=${theme}`);
    await page.getByText('Could not load Rooms', {exact:true}).waitFor();
    await page.screenshot({path:path.resolve(`apps/mobile/evidence/quiet-row-actions/web-desktop-${theme}.png`)});
    await page.getByText('Retry',{exact:true}).nth(2).click();
    await page.getByText('Rooms retried',{exact:true}).waitFor();
    await page.getByText('Retry',{exact:true}).nth(3).click();
    await page.getByText('Corner retried',{exact:true}).waitFor();
    if(errors.length) throw Error(errors.join('\n'));
    console.log(`${theme}: sidebar and inspector Retry passed`);
    await page.close();
  }
} finally { await browser.close(); }
