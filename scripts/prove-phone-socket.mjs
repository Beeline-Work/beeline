/** SOCKET-OPS-1: built server, real session authentication, HTTP and live socket, isolated database. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const human = 'a'.repeat(64), workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222', messageId = 'c'.repeat(64);
const database = new PgliteDatabase(), live = new LiveHub();
const auth = new TokenAuth(database, async subject => ({ subject, login: subject, name: subject }));
const phone = new PhoneService(database, 'http://proof', undefined, undefined, live);
const server = createBeelineServer({ database, auth, live, phone,
  daemon: new DaemonService(database, live), mediaMaximumBytes: 1 });
let socket;
try {
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Socket proof member')`, [human]);
  await database.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('github','socket-proof',$1,'https://github.com','beeline','socket-proof')`, [human]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Socket proof')`, [workspace]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Room',$3)`, [room, workspace, human]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [workspace, room, human]);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = (await auth.exchangeGitHubOidc('socket-proof')).accessToken;
  socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/phone/live`, [`bearer.${token}`]);
  const pending = new Map();
  socket.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.t === 'res') { pending.get(frame.id)?.(frame); pending.delete(frame.id); }
  });
  await once(socket, 'open');
  let sequence = 0;
  const request = (op, args) => new Promise(resolve => {
    const id = `proof-${++sequence}`; pending.set(id, resolve);
    socket.send(JSON.stringify({ t: 'req', id, op, args }));
  });
  const http = (path, args) => fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(args ? { method: 'POST', body: JSON.stringify(args) } : {}),
  });
  const listing = await request('readWorkspaces', {});
  assert.equal(listing.ok, true);
  assert.deepEqual(listing.result, await (await http('/v1/phone/workspaces')).json());
  const args = { roomId: room, messageId, text: 'One message across both transports' };
  assert.equal((await request('sendRoomMessage', args)).result.messageId, messageId);
  assert.equal((await request('sendRoomMessage', args)).result.messageId, messageId);
  assert.equal((await http('/v1/phone/operations/sendRoomMessage', args)).status, 200);
  const view = await request('readRoom', { roomId: room });
  const web = await (await http(`/v1/phone/rooms/${room}`)).json();
  assert.deepEqual(view.result, web);
  assert.equal(web.messages.filter(message => message.id === messageId).length, 1);
  const unknown = await request('notAnOperation', {});
  assert.deepEqual(unknown.error, {
    code: 'unknown_phone_operation', message: 'unknown_phone_operation', retryable: false,
  });
  const before = await database.query(`SELECT id,text,card FROM messages ORDER BY id`);
  const secret = 'refused-proof-value';
  const vault = await request('submitVaultSave', { roomId: room, cardId: messageId, values: { password: secret } });
  assert.equal(vault.ok, false);
  assert.equal(vault.error.code, 'unknown_phone_operation');
  assert.equal(JSON.stringify(vault).includes(secret), false);
  assert.deepEqual((await database.query(`SELECT id,text,card FROM messages ORDER BY id`)).rows, before.rows);
  const replies = await Promise.all(Array.from({ length: 20 }, () => request('readWorkspaces', {})));
  assert.equal(new Set(replies.map(reply => reply.id)).size, 20);
  assert.ok(replies.every(reply => reply.ok));
  console.log('SOCKET-OPS-1 PASS: built server authenticates the live socket, returns identical HTTP/socket Room and Workspace views, reads concurrent requests by id, shows one message after socket and HTTP retries, and refuses vault secret submissions without database changes.');
} finally {
  socket?.terminate(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await database.close();
}
