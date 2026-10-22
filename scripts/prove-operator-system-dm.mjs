/** Local compiled-service acceptance: owner command -> tool operation -> System thread -> recipient read. */
import assert from 'node:assert/strict';
import { migrate } from '../apps/server/dist/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { createAgentCommand, claimAgentCommand } from '../apps/server/dist/agent-command.js';
import { OPERATOR_OWNER_ID, flushOperatorSystemDms } from '../apps/server/dist/operator-system-dm.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
const db = new PgliteDatabase();
try {
  await migrate(db);
  const agent = 'c'.repeat(64), recipient = 'a'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Operator','lunchboxfortwo'),($2,'agent','Proof agent','proof-agent'),
    ($3,'human','Test recipient','proof-recipient')`, [OPERATOR_OWNER_ID, agent, recipient]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, OPERATOR_OWNER_ID]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Operator proof')`, [room, workspace, OPERATOR_OWNER_ID]);
  for (const id of [OPERATOR_OWNER_ID, agent, recipient]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, id, room]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('proof-command',$1,$2,'Send a System DM to proof-recipient saying the issue is fixed.')`, [room, OPERATOR_OWNER_ID]);
  const requestId = 'proof-request', generationId = 'proof-generation';
  const command = await createAgentCommand(db, { roomId: room, agentId: agent, sourceMessageId: 'proof-command', reason: 'human_tag', turnRequestId: requestId });
  await claimAgentCommand(db, room, agent, command.id, generationId);
  const daemon = new DaemonService(db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
    undefined, undefined, { enabled: false }, undefined, undefined, undefined,
    { config: { repository: 'Beeline-Work/beeline', systemSenders: [OPERATOR_OWNER_ID] } });
  const authority = { agentId: agent, roomId: room, requestId, generationId };
  const text = 'Your issue has been fixed. You can use Beeline again.';
  const send = await daemon.execute('sendOperatorSystemDm', { ...authority, recipients: '@proof-recipient', text }, agent);
  assert.equal(send.recipients, 1);
  while (await flushOperatorSystemDms(db)) { /* Drain isolated queue. */ }
  const status = await daemon.execute('readOperatorSystemDm', { ...authority, sendId: send.sendId }, agent);
  assert.deepEqual({ delivered: status.delivered, failed: status.failed, pending: status.pending }, { delivered: 1, failed: 0, pending: 0 });
  const message = (await db.query(`SELECT room_id FROM messages WHERE author_id=$1 AND text=$2`, [SYSTEM_IDENTITY_ID, text])).rows[0];
  const view = await new PhoneService(db, new LiveHub()).readRoom(message.room_id, recipient);
  assert(view.messages.some(item => item.text === text && item.author.pubkey === SYSTEM_IDENTITY_ID));
  console.log('PASS: compiled DaemonService accepted owner command; background delivery committed; recipient PhoneService read shows exact text under System; counts delivered=1 failed=0 pending=0.');
} finally { await db.close(); }
