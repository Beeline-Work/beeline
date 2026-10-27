// Run alongside scripts/prove-rooms-mcp.mjs --serve; uses only its synthetic identity.
const { chromium } = await import(process.env.MCP_BROWSER_PLAYWRIGHT ?? 'playwright-core');
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const origin = process.env.MCP_BROWSER_ORIGIN ?? 'http://127.0.0.1:18965';
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use the loopback synthetic fixture only');
const callbackServer = createServer((req, res) => res.end('Callback received'));
await new Promise((resolve) => callbackServer.listen(9876, '127.0.0.1', resolve));
const browser = await chromium.launch({
  executablePath: process.env.MCP_BROWSER_CHROME ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log('Browser:', m.text()));
  page.on('requestfailed', (r) => console.log('Failed navigation:', r.failure()));
  for (const decision of process.argv.includes('--before') ? ['allow'] : ['allow', 'deny']) {
    const verifier = randomBytes(32).toString('base64url');
    const reg = await fetch(origin + '/mcp/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Browser consent proof',
        redirect_uris: ['http://127.0.0.1:9876/callback'],
      }),
    });
    assert.equal(reg.status, 201);
    const { client_id } = await reg.json();
    const query = new URLSearchParams({
      client_id,
      redirect_uri: 'http://127.0.0.1:9876/callback',
      response_type: 'code',
      resource: origin + '/mcp',
      scope: 'rooms:read rooms:write',
      state: 'browser-proof',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    await page.goto(origin + '/mcp/oauth/authorize?' + query);
    await page.getByRole('link', { name: 'Continue with GitHub' }).click();
    await page.getByRole('button', { name: 'Allow', exact: true }).waitFor();
    const flow = new URL(page.url()).searchParams.get('flow');
    for (const badOrigin of ['https://evil.example', 'null']) {
      const cookies = await page.context().cookies();
      const res = await fetch(origin + '/mcp/oauth/consent', {
        method: 'POST',
        headers: {
          origin: badOrigin,
          cookie: cookies.map((c) => c.name + '=' + c.value).join('; '),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ flow, decision: 'allow' }),
      });
      assert.equal(res.status, 400);
      console.log('Rejected Origin:', badOrigin);
    }
    if (!process.argv.includes('--before')) {
      await page.getByRole('link', { name: 'Edit', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Browser proof member');
      await page
        .getByLabel('Handle', { exact: true })
        .fill('browser_' + randomBytes(4).toString('hex'));
      const saved = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/consent'),
      );
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      assert.equal((await saved).status(), 302);
      console.log('Edit/Save passed');
    }
    const posted = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/consent'),
    );
    await page
      .getByRole('button', { name: decision === 'allow' ? 'Allow' : 'Cancel', exact: true })
      .click();
    const response = await posted;
    console.log(
      'Decision:',
      decision,
      'Origin:',
      (await response.request().allHeaders()).origin,
      'Status:',
      response.status(),
    );
    if (process.argv.includes('--before')) {
      assert.equal(response.status(), 400);
      console.log(await response.text());
      continue;
    }
    assert.equal(response.status(), 302);
    await page.waitForURL('http://127.0.0.1:9876/callback**');
    const target = new URL(response.headers().location);
    assert.equal(target.searchParams.get('state'), 'browser-proof');
    assert.equal(target.searchParams.get('iss'), origin);
    if (decision === 'deny') {
      assert.equal(target.searchParams.get('error'), 'access_denied');
      continue;
    }
    const token = await fetch(origin + '/mcp/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id,
        code: target.searchParams.get('code'),
        code_verifier: verifier,
        redirect_uri: 'http://127.0.0.1:9876/callback',
        resource: origin + '/mcp',
      }),
    });
    assert.equal(token.status, 200);
    const { access_token } = await token.json();
    const rpc = async (method, params = {}) => {
      const r = await fetch(origin + '/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + access_token,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.ok(!text.includes('"error":'));
      assert.ok(!text.includes('"isError":true'));
      console.log(method, 'passed');
      return text;
    };
    await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'browser-proof', version: '1' },
    });
    assert.match(await rpc('tools/list'), /list_rooms/);
    assert.match(await rpc('tools/call', { name: 'list_rooms', arguments: {} }), /result/);
  }
} finally {
  await browser.close();
  callbackServer.close();
}
