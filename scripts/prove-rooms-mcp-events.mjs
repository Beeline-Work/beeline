/** Built-service MCP Events proof. Synthetic identities and loopback receiver only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { RoomsMcp } from '../apps/server/dist/rooms-mcp.js';
import { RoomsMcpOAuth } from '../apps/server/dist/rooms-mcp-oauth.js';
import { RoomsMcpEvents } from '../apps/server/dist/rooms-mcp-events.js';
import { connectMcp } from '../apps/server/dist/rooms-mcp-connections.js';
import { deliverMcpMemberWebhooks } from '../apps/server/dist/rooms-mcp-members.js';

const db = new PgliteDatabase();
const person = 'a'.repeat(64), workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const secrets = new Map(), received = [];
let server, receiver;
process.env.BEELINE_MCP_WEBHOOK_KEY = 'local-events-proof-sealing-key';
try {
  await migrate(db);
  await db.query("INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Events Reviewer','events_reviewer')", [person]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Events proof')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'events-proof','public')", [room, workspace]);
  await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')", [workspace, room, person]);
  receiver = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const secret = secrets.get(req.url);
      assert.ok(secret, 'receiver is scoped to its subscription');
      const event = new Webhook(secret).verify(body, req.headers);
      received.push({ path: req.url, event });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(event.type === 'verification' ? { challenge: event.challenge } : {}));
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  // The only network stand-in maps synthetic HTTPS callbacks to a loopback receiver.
  // Production postMcpWebhook still validates public DNS and pins TLS; no bypass is shipped.
  const transport = async (url, init) => fetch(`http://127.0.0.1:${receiver.address().port}${new URL(url).pathname}`, { method: 'POST', ...init });
  const auth = new TokenAuth(db, async () => { throw new Error('No external login in this fixture'); });
  const live = new LiveHub(), phone = new PhoneService(db, 'http://127.0.0.1', undefined, undefined, live);
  const options = { database: db, auth, phone, live, daemon: new DaemonService(db, live), mediaMaximumBytes: 1024 };
  server = createBeelineServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mount = () => { options.roomsMcp = new RoomsMcp(new RoomsMcpOAuth(db, origin, auth), phone, live,
    undefined, undefined, new RoomsMcpEvents(db, transport)); };
  mount();
  const connections = [];
  for (const client of ['pidoong-proof', 'other-proof']) {
    await db.query('INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES($1,$1,\'[]\')', [client]);
    const tokens = await db.transaction(tx => connectMcp(tx, { client_id: client, identity_id: person, scope: 'rooms:read rooms:write' }));
    const member = (await db.query('SELECT member_id FROM rooms_mcp_members WHERE client_id=$1', [client])).rows[0].member_id;
    const secret = 'whsec_' + randomBytes(32).toString('base64');
    const path = '/' + client;
    secrets.set(path, secret);
    const call = async (method, params = {}) => {
      const response = await fetch(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + tokens.access_token,
        'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.error, undefined, JSON.stringify(result.error));
      return result.result;
    };
    const params = { name: 'mention', arguments: {}, delivery: { mode: 'webhook', url: 'https://hooks.example' + path, secret }, cursor: null };
    assert.deepEqual((await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: client, version: '1' } })).capabilities.events, {});
    assert.equal((await call('events/list')).events[0].name, 'mention');
    const subscription = await call('events/subscribe', params);
    assert.equal((await call('events/subscribe', params)).id, subscription.id);
    connections.push({ client, member, call, params, subscription });
  }
  assert.equal(received.length, 2, 'refresh caches the challenge');
  mount(); // Recreate the MCP service; verified subscriptions live in PostgreSQL.
  const target = connections[0];
  const handle = (await db.query('SELECT handle FROM identities WHERE id=$1', [target.member])).rows[0].handle;
  const tag = await phone.execute('sendRoomMessage', { roomId: room, text: '@' + handle + ' please reply here' }, person);
  assert.equal(await deliverMcpMemberWebhooks(db, transport), 1);
  assert.equal(await deliverMcpMemberWebhooks(db, transport), 0);
  const event = received.filter(item => item.event.name === 'mention');
  assert.equal(event.length, 1);
  assert.equal(event[0].path, '/pidoong-proof', 'no cross-member delivery');
  assert.equal(event[0].event.data.messageId, tag.messageId);
  const _meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'proof', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  assert.deepEqual((await target.call('server/discover', { _meta })).capabilities.events, {});
  assert.equal((await target.call('events/list', { _meta })).resultType, 'complete');
  assert.ok((await target.call('tools/list', { _meta })).tools.some(t => t.name === 'send_message'));
  const reply = await target.call('tools/call', { _meta, name: 'send_message', arguments: { room, text: 'I received the Room tag.', replyTo: tag.messageId } });
  assert.notEqual(reply.isError, true);
  const replyId = JSON.parse(reply.content[0].text).data.messageId;
  assert.equal((await db.query('SELECT author_id FROM messages WHERE id=$1', [replyId])).rows[0].author_id, target.member);
  assert.match(JSON.stringify(await phone.readRoom(room, person)), /I received the Room tag/);
  await target.call('events/unsubscribe', { name: 'mention', arguments: {}, delivery: { mode: 'webhook', url: target.params.delivery.url } });
  await phone.execute('sendRoomMessage', { roomId: room, text: '@' + handle + ' after unsubscribe' }, person);
  assert.equal(await deliverMcpMemberWebhooks(db, transport), 0);
  console.log('MCP-EVENTS-1 PASS: authenticated discovery, signed challenge, refresh, persistent subscription, one signed tag to its own member, MCP 2.0 tools, visible reply under its own byline, unsubscribe.');
  console.log('Stand-ins: synthetic consent via connectMcp and loopback callback transport. Live ChatGPT/Pidoong connection remains post-release owner proof.');
} finally {
  server?.closeAllConnections(); receiver?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  if (receiver) await new Promise(resolve => receiver.close(resolve));
  await db.close();
}
