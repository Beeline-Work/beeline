/** Feature proof ML-1: built HTTP lookup and the existing targeted-history route. */
import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const human = 'a'.repeat(64), stranger = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const database = new PgliteDatabase();
const live = new LiveHub();
const auth = new TokenAuth(database, async (subject) => ({ subject, login: subject, name: subject }));
const server = createBeelineServer({ database, auth, live,
  phone: new PhoneService(database, 'http://proof'), daemon: new DaemonService(database, live), mediaMaximumBytes: 1024 });
try {
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Member'),($2,'human','Stranger')`, [human, stranger]);
  for (const [subject, identity] of [['member', human], ['stranger', stranger]]) {
    await database.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
      VALUES('github',$1,$2,'https://github.com','beeline',$1)`, [subject, identity]);
  }
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'same-name'),($2,$3,'same-name')`, [room, corner, workspace]);
  await database.query(`UPDATE rooms SET parent_id=$1,archived_at=now() WHERE id=$2`, [room, corner]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [workspace, human, room]);
  for (const [id, address] of [['1'.repeat(64), room], ['2'.repeat(64), corner]]) {
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'target message')`, [id, address, human]);
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const memberSession = await auth.exchangeGitHubOidc('member');
  assert.equal(memberSession.identityId, human);
  const memberToken = memberSession.accessToken;
  const strangerToken = (await auth.exchangeGitHubOidc('stranger')).accessToken;
  const get = (path, token = memberToken) => fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
  for (const [messageId, roomId] of [['1'.repeat(64), room], ['2'.repeat(64), corner]]) {
    const lookup = await get(`/v1/phone/message-links/${messageId}`);
    assert.equal(lookup.status, 200, await lookup.clone().text());
    assert.deepEqual(await lookup.json(), { messageId, roomId, workspaceId: workspace });
    const history = await get(`/v1/phone/rooms/${roomId}/history?around=${messageId}`);
    assert.equal(history.status, 200);
    assert.ok((await history.json()).messages.some((message) => message.id === messageId));
    const denied = await get(`/v1/phone/message-links/${messageId}`, strangerToken);
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { error: 'not_found' });
  }
  console.log('ML-1 PASS: built authenticated HTTP resolves Room and archived corner by message id despite identical names; targeted history contains both messages; non-member gets only not_found.');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await database.close();
}

process.exit(0);
