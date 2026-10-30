// node capture-web.mjs <before|after>: serve the web build, sign in, capture each scene in Bone and Obsidian.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
const side = process.argv[2];
const dir = '/home/alan/.cache/niglet-tray-shots';
const port = 8483;
const srv = spawn('node', [`${dir}/work/serve.mjs`, `${dir}/web-${side}`, String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const seed = (scene) => JSON.parse(execFileSync('node', [`${dir}/work/seed.mjs`, scene]).toString());
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const theme of ['light', 'dark']) {
    const name = theme === 'light' ? 'bone' : 'obsidian';
    for (const scene of ['tray', 'actions', 'chat']) {
      const { general } = seed(scene);
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      // The after build talks to the after server; both builds bake in :8897.
      if (process.env.API_PORT) await ctx.route('http://127.0.0.1:8897/**', async (route) => {
        const response = await route.fetch({ url: route.request().url().replace(':8897', ':' + process.env.API_PORT) });
        await route.fulfill({ response });
      });
      await page.goto(`http://127.0.0.1:${port}/review/niglet-tray-local-review-secret-01`);
      await page.waitForURL(/channels/, { timeout: 90000 });
      await page.evaluate((t) => { const k = 'beeline.settings.local-settings'; const v = JSON.parse(localStorage.getItem(k) || '{}'); v.appearance = t; localStorage.setItem(k, JSON.stringify(v)); }, theme);
      const url = scene === 'chat' ? `/beeline/chat/${general}` : '/beeline/tray?communityId=bee11e00-0000-4000-8000-000000000105';
      await page.goto(`http://127.0.0.1:${port}${url}`);
      await page.waitForTimeout(scene === 'chat' ? 7000 : 5000);
      await page.mouse.move(1270, 890);
      await page.screenshot({ path: `${dir}/shots/web-${side}-${scene}-${name}.png` });
      const text = await page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | ').slice(0, 1200));
      console.log(side, scene, name, text);
      await ctx.close();
    }
  }
} finally { await browser.close(); srv.kill(); }
