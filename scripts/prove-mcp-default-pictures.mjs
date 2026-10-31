/** R-MCP-DEFAULT-PICTURES. Run against prove-rooms-mcp.mjs --serve on loopback. */
const { chromium } = await import(process.env.MCP_BROWSER_PLAYWRIGHT ?? 'playwright-core');
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const origin = process.env.MCP_BROWSER_ORIGIN ?? 'http://127.0.0.1:19783';
assert.equal(new URL(origin).hostname, '127.0.0.1');
const before = process.argv.includes('--before');
const stage = before ? 'before' : 'after';
const output = 'apps/mobile/evidence/mcp-default-pictures';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  if (process.argv.includes('--room-bylines')) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('http://127.0.0.1:19784');
    await page.getByText('Firstmate', { exact: true }).waitFor({ timeout: 120_000 });
    await page.getByText('Muse', { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const pictures = [...document.querySelectorAll('img[src*="/v1/agent-avatars/"]')];
      return pictures.length === 2 && pictures.every(image => image.complete && image.naturalWidth > 0);
    });
    await page.screenshot({ path: output + '/room-bylines-after-bone-phone.png' });
    console.log('R-MCP-DEFAULT-PICTURES: real LedgerBylineView loaded both served member portraits');
    process.exitCode = 0;
  } else for (const [key, name, redirects] of [
    ['grok-bot', 'Cursor', ['https://www.cursor.com/agents/mcp/oauth/callback', 'http://localhost:8787/callback']],
    ['muse', 'Meta Muse', ['https://agent.meta.ai/api/hatch/oauth/callback']],
  ]) {
    const page = await browser.newPage();
    const reg = await fetch(origin + '/mcp/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: redirects }) });
    assert.equal(reg.status, 201);
    const { client_id } = await reg.json();
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ client_id, redirect_uri: redirects[0], response_type: 'code', resource: origin + '/mcp', scope: 'rooms:read rooms:write', state: 'avatar-proof', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    await page.goto(origin + '/mcp/oauth/authorize?' + query);
    await page.getByRole('link', { name: 'Continue with GitHub' }).click();
    await page.getByRole('button', { name: 'Allow', exact: true }).waitFor();
    const expected = key === 'grok-bot' && !before ? 'Grok Bot' : name;
    assert.ok(await page.getByRole('heading', { name: `Add ${expected} to your team` }).count());
    if (!before) assert.equal(await page.locator('img.plate').count(), 1);
    if (before && key === 'grok-bot') assert.equal(await page.locator('span.plate').textContent(), 'C');
    for (const [theme, colorScheme] of [['bone', 'light'], ['obsidian', 'dark']]) {
      await page.emulateMedia({ colorScheme });
      for (const [widthName, width, height] of [['phone', 390, 844], ['web', 1280, 1000]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${output}/${key}-${stage}-${theme}-${widthName}.png`, fullPage: true });
      }
    }
    if (!before) {
      const flow = new URL(page.url()).searchParams.get('flow');
      const cookie = (await page.context().cookies()).map(c => `${c.name}=${c.value}`).join('; ');
      const approved = await fetch(origin + '/mcp/oauth/consent', { method: 'POST', redirect: 'manual', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ flow, decision: 'allow' }) });
      assert.equal(approved.status, 302);
      const code = new URL(approved.headers.get('location')).searchParams.get('code');
      const token = await fetch(origin + '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', client_id, code, code_verifier: verifier, redirect_uri: redirects[0], resource: origin + '/mcp' }) });
      assert.equal(token.status, 200);
      const { access_token } = await token.json();
      const client = new Client({ name: 'avatar-proof', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + access_token } } }));
      const profile = await client.callTool({ name: 'set_profile', arguments: { name: key === 'muse' ? 'Muse' : 'Firstmate' } });
      assert.ok(!profile.isError);
      const sent = await client.callTool({ name: 'send_message', arguments: { room: '22222222-2222-4222-8222-222222222222', text: `${key === 'muse' ? 'Muse' : 'Firstmate'} connected with the default app picture.`, idempotencyKey: 'avatar-' + key } });
      assert.ok(!sent.isError, JSON.stringify(sent));
      await client.close();
    }
    await page.close();
    console.log(`R-MCP-DEFAULT-PICTURES ${stage}: ${key} Allow verified in Bone/Obsidian, phone/web`);
  }
  if (!before && !process.argv.includes('--room-bylines')) {
    const members = await (await fetch(origin + '/proof/avatar-members')).json();
    for (const m of members) {
      const avatar = await fetch(origin + m.avatar);
      assert.equal(avatar.status, 200);
      assert.equal(avatar.headers.get('content-type'), 'image/webp');
      m.avatarUrl = origin + m.avatar;
    }
    await writeFile(output + '/members.json', JSON.stringify(members, null, 2));
  }
} finally { await browser.close(); }
