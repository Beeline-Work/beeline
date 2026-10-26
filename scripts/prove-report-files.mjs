// FILE-HANDOFF: isolated built-service proof; no production messages or media.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PgliteDatabase, MemoryObjectStorage } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { ObjectService } from '../apps/server/dist/object-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { flushDueCommanderWakes } from '../apps/server/dist/commander-wakes.js';

for (const delivery of ['report', 'postRoomMessage']) {
  const db = new PgliteDatabase(), storage = new MemoryObjectStorage();
  const human = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  const dm = '33333333-3333-4333-8333-333333333333';
  const tokens = new Map([[commander, 'bdt_commander_fixture_token'], [worker, 'bdt_worker_fixture_token']]);
  let server;
  try {
    await migrate(db);
    await storage.listen();
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`, [human, commander, worker]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [commander, worker, human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'File handoff proof')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by) VALUES
      ($1,$3,'Work',NULL,$4),($2,$3,'Owner and commander',jsonb_build_array($4::text,$5::text),$4)`, [room, dm, workspace, human, commander]);
    for (const member of [human, commander, worker]) {
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, member, room]);
      if (member !== worker) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,$2,$3,'member')`, [workspace, dm, member]);
    }
    for (const [agent, token] of tokens) await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(token), agent]);
    const live = new LiveHub(), daemon = new DaemonService(db, live);
    const phone = new PhoneService(db, 'http://proof');
    const objects = new ObjectService(db, storage.asStorage(), 'http://proof');
    server = createBeelineServer({ database: db, daemon, phone, live, objectService: objects,
      auth: new TokenAuth(db, async () => { throw new Error('unused'); }), mediaMaximumBytes: 1024 * 1024 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = async (name, input, agent = commander) => {
      const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
        method: 'POST', headers: { authorization: `Bearer ${tokens.get(agent)}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      assert.equal(response.status, 200, `${name}: ${JSON.stringify(body)}`);
      return body;
    };
    const authority = turn => ({ roomId: turn.roomId, requestId: turn.turnRequestId, generationId: 'proof' });
    const claim = turn => call('claimAgentCommand', { roomId: turn.roomId, commandId: turn.id, generationId: 'proof' }, turn.agentId);
    await phone.execute('sendRoomMessage', { roomId: dm, messageId: randomBytes(32).toString('hex'), text: 'Prepare both files' }, human);
    const order = (await call('getAgentCommands', { roomId: dm })).commands[0];
    await claim(order);
    await call('setWakeDelivery', { roomId: dm, delivery: 'batch:1' });
    const turns = [];
    for (const name of ['first.txt', 'second.txt']) {
      const opened = await call('createCorner', { ...authority(order), targetRoomId: room, name,
        idempotencyKey: name, objective: 'Prepare file', implementer: 'worker',
        brief: { spec: 'Prepare file', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } });
      const turn = (await call('getAgentCommands', { roomId: opened.cornerId }, worker)).commands[0];
      await claim(turn);
      const uploaded = await objects.uploadArtifact(worker, Buffer.from(name), 'text/plain', name);
      await call('postAgentAttachment', { ...authority(turn), attachment: {
        url: uploaded.url, name, mimeType: 'text/plain', size: Buffer.byteLength(name),
      } }, worker);
      turns.push({ turn, name });
    }
    for (const { turn, name } of turns) await call('report', { ...authority(turn), status: 'done', text: `done: ${name} attached` }, worker);
    await db.query(`UPDATE agent_commands SET wake_after=now() WHERE wake_after IS NOT NULL`);
    await flushDueCommanderWakes(db);
    const batched = (await call('getAgentCommands', { roomId: dm })).commands.find(turn => turn.reason === 'report');
    assert.equal(batched.source.attachments.length, 2);
    // A commander can reopen each private report by its id, including the folded source.
    for (const row of (await db.query(`SELECT id FROM agent_commands WHERE reason='report' AND agent_id=$1`, [commander])).rows) {
      const message = await call('getRoomMessage', { roomId: dm, messageId: row.id });
      assert.equal(message.attachments.length, 1);
    }
    await claim(batched);
    await call(delivery, { ...authority(batched), text: 'done: first.txt and second.txt attached', ...(delivery === 'report' ? { status: 'done' } : {}) });
    const visible = (await phone.readRoom(dm, human)).messages.filter(message => message.attachments?.length);
    assert.equal(visible.length, 1);
    assert.deepEqual(visible[0].attachments.map(file => file.name), ['first.txt', 'second.txt']);
    for (const file of visible[0].attachments) {
      const response = await fetch(`${origin}/v1/media/${file.url.split('/').at(-1)}`, {
        headers: { authorization: `Bearer ${tokens.get(commander)}` },
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), file.name);
    }
    console.log(`FILE-HANDOFF PASS (${delivery}): commander reopens private reports; person sees both file cards and opens both original files through built HTTP service.`);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await storage.close();
    await db.close();
  }
}
