import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DaemonApiClient } from '../../body/src/daemon-api-client.js';
import { createAgentCommand } from './agent-command.js';
import { TokenAuth, tokenHash } from './auth.js';
import { ConnectionPresence } from './connection-presence.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { insertCornerFacts, migratedDatabase, type PgliteDatabase } from './test-support.js';

const agent = 'a'.repeat(64), person = 'b'.repeat(64);
const workspace = randomUUID(), parent = randomUUID();
const token = `bdt_${'c'.repeat(43)}`;
let db: PgliteDatabase, api: DaemonApiClient, phone: PhoneService;
let server: ReturnType<typeof createBeelineServer>, presence: ConnectionPresence, origin: string;

beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Synthetic worker'),($2,'human','Synthetic owner')`, [agent, person]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, person]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Close proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Parent')`, [parent, workspace]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'member'),($1,$3,$2,'member'),($1,NULL,$4,'owner'),($1,$3,$4,'owner')`,
  [workspace, agent, parent, person]);
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(token), agent]);
  const live = new LiveHub();
  presence = new ConnectionPresence(db, live);
  phone = new PhoneService(db, 'http://synthetic.invalid');
  server = createBeelineServer({ database: db, live, phone, daemon: new DaemonService(db, live),
    auth: new TokenAuth(db, async () => { throw new Error('unused'); }), connectionPresence: presence, mediaMaximumBytes: 1 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api = new DaemonApiClient(origin, token, agent);
}, 60_000);

afterAll(async () => {
  api?.closeLive();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await presence?.stop();
  await db?.close();
});

async function corner() {
  const id = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Finished work')`, [id, workspace, parent]);
  await insertCornerFacts(db, { cornerId: id, ownerAgentId: agent, workflowState: 'implement' });
  expect((await db.query(`SELECT 1 FROM memberships WHERE room_id=$1`, [id])).rowCount).toBe(0);
  return id;
}

async function archived(id: string) {
  return (await db.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [id])).rows[0]!.archived;
}

it.each([['machine', 'working'], ['machine', 'complete'], ['http', 'working'], ['http', 'complete']] as const)(
  'closes through %s with parent membership and a %s owned helper turn', async (transport, state) => {
    const cornerId = await corner(), requestId = randomUUID(), generationId = randomUUID();
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Finish this work')`, [requestId, cornerId, person]);
    const command = (await createAgentCommand(db, { roomId: cornerId, agentId: agent, sourceMessageId: requestId, reason: 'human_mention' }))!;
    await api.execute('claimAgentCommand', { roomId: cornerId, commandId: command.id, generationId });
    if (state === 'complete') {
      await db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [command.id]);
      await db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND agent_id=$2`, [cornerId, agent]);
    }
    const input = { cornerId, roomId: cornerId, requestId, generationId };
    if (transport === 'machine') await api.execute('archiveCorner', input);
    else {
      const response = await fetch(`${origin}/v1/daemon/operations/archiveCorner`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200 });
    }
    expect(await archived(cornerId)).toBe(true);
    expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [command.id])).rows[0]!.state)
      .toBe(state === 'working' ? 'cancelled' : 'complete');
    expect((await db.query(`SELECT 1 FROM turn_owned_effect_fences`)).rowCount).toBe(0);
  },
);

it('uses target parent membership when the helper context names an archived source corner, and confirms a repeated close', async () => {
  const cornerId = await corner(), source = await corner();
  await phone.execute('requestCornerClose', { roomId: source }, person);
  const input = { cornerId, roomId: source, requestId: 'finished-source', generationId: 'finished-generation' };
  await api.execute('archiveCorner', input);
  expect(await archived(cornerId)).toBe(true);
  await api.execute('archiveCorner', input);
  expect(await archived(cornerId)).toBe(true);
});

it('keeps person close working through parent Room membership', async () => {
  const cornerId = await corner();
  await phone.execute('requestCornerClose', { roomId: cornerId }, person);
  expect(await archived(cornerId)).toBe(true);
});

it('refuses target access after parent membership is removed even with a member source Room', async () => {
  const cornerId = await corner(), other = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Other')`, [other, workspace]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace, other, agent]);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [parent, agent]);
  try {
    await expect(api.execute('archiveCorner', { cornerId, roomId: other })).rejects.toThrow('access denied');
    expect(await archived(cornerId)).toBe(false);
  } finally {
    await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [parent, agent]);
  }
});
