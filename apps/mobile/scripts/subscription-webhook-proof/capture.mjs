const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? 'playwright-core');
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const out = root + '/.verification/subscription-webhook';
const browser = await chromium.launch({executablePath:'/usr/bin/google-chrome', headless:true, args:['--no-sandbox']});
const page = await browser.newPage({viewport:{width:390,height:1020},deviceScaleFactor:1});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
for (const theme of ['obsidian','bone']) {
  await page.goto(pathToFileURL(out+'/index.html').href+'?theme='+theme);
  await page.getByTestId('webhook-token').waitFor();
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:out+'/'+theme+'-steady.png',fullPage:true});
  if ((await page.getByTestId('subscription-header').innerText()).includes('Cursor automation') === false) throw Error('Missing own title');
  await page.getByTestId('webhook-token').click();
  await page.getByText('bl_whk_'+('1234567890abcdef'.repeat(2) + '12345678901'),{exact:true}).waitFor();
  await page.screenshot({path:out+'/'+theme+'-show.png',fullPage:true});

  await page.getByTestId('webhook-rotate').click();
  await page.getByText('The old token stops working at once.',{exact:true}).waitFor();
  await page.screenshot({path:out+'/'+theme+'-rotate.png',fullPage:true});
  await page.getByTestId('webhook-rotate-cancel').click();
  if (await page.getByTestId('webhook-rotate-confirm').count()) throw Error('Cancel did not restore row');
  await page.getByTestId('webhook-rotate').click();
  await page.getByTestId('webhook-rotate-confirm').click();
  await page.getByTestId('webhook-rotate').waitFor();
  await page.getByTestId('webhook-link').click();
  if (await page.evaluate(()=>window.__clipboard) !== 'usebeeline.app/hooks/w_7Kq2mX9pLr') throw Error('Link was not copied');
  await page.getByTestId('webhook-token').click();
  if (!(await page.evaluate(()=>window.__clipboard))?.startsWith('bl_whk_')) throw Error('Token was not copied');
  const ops=await page.evaluate(()=>window.__operations);
  if (ops.join(',')!=='revealWebhookToken,rotateWebhookToken') throw Error('Token controls did not call service');
  const overflow = await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth);
  if(overflow) throw Error('Horizontal overflow');
  const tokenOverflow = await page.getByTestId('webhook-token').evaluate(row =>
    Array.from(row.querySelectorAll('*')).some(el => el.scrollWidth > el.clientWidth + 1));
  if(tokenOverflow) throw Error('Token overflow inside row');
}
await page.goto(pathToFileURL(out+'/index.html').href+'?member=1');
await page.getByTestId('subscription-page').waitFor();
if(await page.getByTestId('webhook-link').count()) throw Error('Non-admin sees Link');
await page.goto(pathToFileURL(out+'/index.html').href+'?fail=1');
await page.getByTestId('webhook-token').click();
await page.getByText('Could not show the token. Try again.',{exact:true}).waitFor();
await browser.close();
if(errors.length) throw Error(errors.join('\n'));
console.log('Actual detail screen: dark/Bone steady, Show, rotate, cancel, rotation request, non-admin hidden Link, and recoverable error passed at 390 pt.');
