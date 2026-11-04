/** Generic MCP proof against the isolated fixture, optionally through its HTTPS tunnel.
 * JOIN_PROOF_ORIGIN names the fixture. JOIN_PROOF_TOKENS names a private JSON file
 * with { short, join } access tokens from the local CLI sign-ins. Never prints tokens.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const origin = new URL(process.env.JOIN_PROOF_ORIGIN ?? 'http://localhost:18979').origin;
const host = new URL(origin).hostname;
assert.ok(['localhost', '127.0.0.1', 'join.localtest.me'].includes(host) || host.endsWith('.trycloudflare.com'), 'Only a local fixture or its quick tunnel is allowed');
const tokens = process.env.JOIN_PROOF_TOKENS ? JSON.parse(await readFile(process.env.JOIN_PROOF_TOKENS, 'utf8')) : undefined;
const room = '22222222-2222-4222-8222-222222222222';
for (const path of ['/', '/join', '/mcp']) {
  const url = origin + path;
  const plain = await fetch(url);
  assert.equal(plain.status, path === '/mcp' ? 401 : 200);
  if (path !== '/mcp') assert.match(await plain.text(), /Join my Beeline Room: join.usebeeline.app/);
  const initialize = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'unified-join-generic-proof', version: '1' } } }) });
  assert.equal(initialize.status, 401);
  const challenge = initialize.headers.get('www-authenticate');
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)[1];
  assert.equal(metadataUrl, origin + '/.well-known/oauth-protected-resource' + (path === '/' ? '' : path));
  const metadata = await (await fetch(metadataUrl)).json();
  assert.equal(metadata.resource, url);
  assert.deepEqual(metadata.authorization_servers, [origin]);
  const issuer = await (await fetch(origin + '/.well-known/oauth-authorization-server')).json();
  assert.equal(issuer.issuer, origin);
  assert.equal(issuer.authorization_endpoint, origin + '/mcp/oauth/authorize');
  const proof = { url, plainGet: plain.status, initialize: initialize.status, challenge, metadata, issuer };
  if (tokens) {
    const client = new Client({ name: 'unified-join-generic-proof', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${path === '/join' ? tokens.join : tokens.short}` } } }));
      const tools = await client.listTools();
      const listed = await client.callTool({ name: 'list_rooms', arguments: {} });
      const rooms = JSON.parse(listed.content[0].text).data;
      assert.equal(rooms.owner.handle, 'join-reviewer');
      const read = await client.callTool({ name: 'read_messages', arguments: { room } });
      assert.notEqual(read.isError, true);
      const posted = await client.callTool({ name: 'send_message', arguments: { room, text: `SDK-PROOF: initialized, read and posted through ${path}`, idempotencyKey: `sdk-join-proof:${path}` } });
      assert.notEqual(posted.isError, true);
      proof.authenticated = { initialized: true, toolCount: tools.tools.length, owner: rooms.owner.handle, read: true, messageId: JSON.parse(posted.content[0].text).data.messageId };
    } finally { await client.close(); }
  }
  console.log(JSON.stringify(proof));
}
