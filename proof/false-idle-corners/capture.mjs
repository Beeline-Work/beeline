import { chromium } from '/home/lunchbox/gstack/node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({executablePath:'/home/lunchbox/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']});
try {
  const page = await browser.newPage({viewport:{width:1200,height:700}});
  page.on('pageerror',e=>console.log('pageerror', e.message));
  for (const theme of ['bone','obsidian']) {
    await page.goto(`http://127.0.0.1:8847/proof/false-idle-corners/?theme=${theme}`);
    await page.getByText('working',{exact:true}).waitFor();
    await page.getByText(/^scheduled · Next run/).waitFor();
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:`proof/false-idle-corners/${theme}.png`,fullPage:true});
    console.log(theme, await page.locator('main').innerText());
  }
} finally {await browser.close();}
