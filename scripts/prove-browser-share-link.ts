/** Reproduction 2026-10-20: built HTTP entry, phone sign-in, authorization and viewer. */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { readRoomViewMessage } from '@beeline/api-contract/phone';
import { PgliteDatabase } from '../apps/server/src/test-support.js';

const HUMAN = 'a'.repeat(64), AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
async function main() {
const { migrate } = await import('../apps/server/dist/database.js');
const { TokenAuth } = await import('../apps/server/dist/auth.js');
const { PhoneService } = await import('../apps/server/dist/phone-service.js');
const { DaemonService } = await import('../apps/server/dist/daemon-service.js');
const { LiveHub } = await import('../apps/server/dist/live.js');
const { createBeelineServer } = await import('../apps/server/dist/server.js');
const { createComputerSession, getComputerSession, endComputerSession } = await import('../apps/server/dist/computer-session.js');
const database = new PgliteDatabase();
const live = new LiveHub();
const auth = new TokenAuth(database, async () => ({ subject: 'browser-proof', login: 'proof', name: 'Proof' }));
const server = createBeelineServer({ database, auth, live,
  phone: new PhoneService(database, 'http://proof'), daemon: new DaemonService(database, live), mediaMaximumBytes: 1024 });
let socket: WebSocket | undefined;
try {
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Proof'),($2,'agent','Agent')`, [HUMAN, AGENT]);
  await database.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('github','browser-proof',$1,'https://github.com','beeline','proof')`, [HUMAN]);
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'Private Room',$3::jsonb)`, [ROOM, WORKSPACE, JSON.stringify([HUMAN, AGENT])]);
  for (const id of [HUMAN, AGENT]) {
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WORKSPACE, id, ROOM]);
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (await auth.exchangeGitHubOidc('fixture-assertion')).accessToken;
  socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/phone/live`, [`bearer.${token}`]);
  const received: Array<Record<string, unknown>> = [];
  socket.on('message', raw => received.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
  socket.send(JSON.stringify({ type: 'subscribe', roomIds: [ROOM] }));
  async function waitForFrame(type: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const frame = received.find(frame => frame.type === type);
      if (frame) return frame;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Missing live ${type}`);
  }
  await waitForFrame('subscribed');
  const share = await createComputerSession(database, live, { roomId: ROOM, agentId: AGENT, sessionId: 'proof', upstreamUrl: 'body:' });
  const delta = await waitForFrame('message-delta');
  const card = readRoomViewMessage(delta.message);
  assert.equal(card?.id, share.messageId);
  assert.equal(card?.computerSession?.id, share.id);
  assert.equal(card?.computerSession?.status, 'live');
  console.log('Reproduction SHARE-CARD-DM-1 PASS: open owner DM receives the committed live browser card over its existing socket, without a reload or LISTEN bridge.');
  const bare = await fetch(`${origin}/s/${share.id}/`);
  assert.equal(bare.status, 200);
  const html = await bare.text();
  assert.ok(html.includes(share.beelineUrl));
  assert.ok(html.includes(`beeline://beeline/browser-share?id=${share.id}`));
  assert.ok(!html.includes('Private Room'));
  const open = (bearer?: string) => fetch(`${origin}/v1/phone/operations/openComputerSession`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ id: share.id }),
  });
  assert.equal((await open()).status, 401);
  const permitted = await open(token);
  assert.equal(permitted.status, 200);
  const { access } = await permitted.json() as { access: string };
  const viewer = await fetch(`${origin}/s/${share.id}/?access=${access}`);
  assert.equal(viewer.status, 200);
  assert.ok((await viewer.text()).includes('Page.screencastFrame'));
  await database.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, HUMAN]);
  const denied = await fetch(`${origin}/s/${share.id}/?access=${access}`);
  assert.equal(denied.status, 403);
  assert.ok((await denied.text()).includes('do not have access'));
  await database.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [ROOM, HUMAN]);
  await endComputerSession(database, live, (await getComputerSession(database, share.id))!);
  const ended = await fetch(`${origin}/s/${share.id}/?access=${access}`);
  assert.equal(ended.status, 410);
  assert.ok((await ended.text()).includes('has ended'));
  console.log(`Reproduction 2026-10-20 PASS: bare link 200 (${Buffer.byteLength(html)} bytes); unsigned phone open 401; signed phone open 200; viewer 200; revoked membership 403 with explanation; ended 410 with explanation.`);
} finally {
  socket?.terminate();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
}

}
void main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => process.exit(process.exitCode ?? 0));
