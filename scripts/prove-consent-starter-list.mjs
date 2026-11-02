// Run with the synthetic local server from prove-rooms-mcp.mjs --serve.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { MCP_STARTER_ROUTINE } from '@beeline/api-contract/phone';

const { chromium } = await import(process.env.MCP_BROWSER_PLAYWRIGHT ?? 'playwright-core');
const origin = process.env.MCP_BROWSER_ORIGIN ?? 'http://127.0.0.1:18965';
assert.equal(new URL(origin).hostname, '127.0.0.1');
const before = process.argv.includes('--before');
const output = process.env.MCP_STARTER_EVIDENCE ?? '/tmp/jellybean-consent-evidence';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.MCP_BROWSER_CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const registered = await fetch(origin + '/mcp/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Starter list proof', redirect_uris: ['http://127.0.0.1:9876/callback'] }),
  });
  assert.equal(registered.status, 201);
  const { client_id } = await registered.json();
  const query = new URLSearchParams({ client_id, redirect_uri: 'http://127.0.0.1:9876/callback', response_type: 'code',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url') });
  await page.goto(origin + '/mcp/oauth/authorize?' + query);
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await page.getByRole('button', { name: 'Copy', exact: true }).waitFor();
  const routine = page.locator('#starter-routine');
  assert.equal(await routine.evaluate(node => node.tagName), before ? 'DIV' : 'OL');
  if (!before) assert.deepEqual(await routine.locator('li').allTextContents(), MCP_STARTER_ROUTINE.split('\n').filter(line => line.trim()));
  for (const [device, width] of [['desktop', 1280], ['phone', 390]]) {
    for (const colorScheme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.locator('.routine').screenshot({ path: `${output}/${before ? 'before' : 'after'}-${device}-${colorScheme}.png` });
    }
  }
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /^Copied$/ }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), MCP_STARTER_ROUTINE);
  console.log('PASS: Copy clipboard equals MCP_STARTER_ROUTINE exactly');
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new Error('Denied for fallback proof'); } }); });
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Could not copy.' }).waitFor();
  const selected = await page.evaluate(() => window.getSelection().toString());
  assert.deepEqual(selected.split('\n').map(line => line.trim()).filter(Boolean), MCP_STARTER_ROUTINE.split('\n').filter(Boolean));
  console.log('PASS: Clipboard denial selects every instruction on readable separate lines');
  console.log(`PASS: ${before ? 'before plain lines' : 'after numbered list'} captured in Bone and Obsidian, desktop and phone`);
} finally { await browser.close(); }
