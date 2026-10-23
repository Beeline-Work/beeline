/**
 * Isolated Android approval proof. Runs production DaemonService/PhoneService
 * against an ephemeral PGlite database. /decide simulates a Squire relay event;
 * it does not contact a vault or perform a real passkey approval.
 * Run from the repository root: node --import tsx scripts/prove-squire-approval-cleanup.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/src/database.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { createAgentCommand, claimAgentCommand } from '../apps/server/src/agent-command.js';
const db = new PgliteDatabase();
await migrate(db);
const owner = 'a'.repeat(64),
  agent = 'b'.repeat(64),
  request = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
await db.query(
  `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Jellybean','jellybean')`,
  [owner, agent],
);
await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Approval proof')`, [workspace]);
await db.query(
  `INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'proof',NULL),($3,$2,'proof corner',$1)`,
  [room, workspace, corner],
);
await db.query(
  `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
  [workspace, owner, agent, room],
);
const daemon = new DaemonService(db, new LiveHub());
const phone = new PhoneService(db, 'http://10.0.2.2:18740');
for (const target of [room, corner]) {
  const req = target === room ? request : 'd'.repeat(64);
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,'@jellybean use the test credential','message')`,
    [req, target, owner],
  );
  const command = await createAgentCommand(db, {
    roomId: target,
    agentId: agent,
    sourceMessageId: req,
    turnRequestId: req,
    reason: 'fixture',
  });
  if (!command) throw new Error('No command');
  await claimAgentCommand(db, target, agent, command.id, 'proof-generation');
  await daemon.execute(
    'postSquireApproval',
    {
      roomId: target,
      requestId: req,
      generationId: 'proof-generation',
      tool: 'fetch_credential',
      title: 'Credential access approval',
      detail: 'Reveal test credential',
      approvalId: `proof-${target}`,
      approvalUrl: 'https://approve.example.test/proof',
      linkKind: 'approval',
    },
    agent,
  );
}
const dm = (
  await db.query(`SELECT room_id FROM messages WHERE card_type='squire-approval' LIMIT 1`)
).rows[0].room_id;
let decided = false;
async function snapshot() {
  const system = await phone.readRoom(dm, owner);
  const rooms = await Promise.all(
    [room, corner].map(async (roomId) => {
      const view = await phone.readRoom(roomId, owner);
      const inbox = await daemon.execute('getRoomConversation', { roomId }, agent);
      return {
        name: roomId === room ? 'Room' : 'Corner',
        messages: view?.messages.map((m) => m.text),
        decisions: inbox.items
          .filter((m) => m.systemEvent?.kind === 'squire-approval-decided')
          .map((m) => ({ type: m.type, requestId: m.requestId, body: m.body })),
      };
    }),
  );
  const commands = (
    await db.query(
      `SELECT action,state,turn_request_id FROM agent_commands WHERE action='resume' ORDER BY room_id`,
    )
  ).rows;
  return { approval: system?.messages.find((m) => m.squireApproval), rooms, commands, decided };
}
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/v1/connectors/logo/trusty-squire.svg') {
      res.setHeader('content-type', 'image/svg+xml');
      res.end(await readFile('apps/server/assets/connectors/trusty-squire.svg'));
      return;
    }
    if (req.url === '/decide' && req.method === 'POST' && !decided) {
      for (const target of [room, corner])
        await daemon.execute(
          'postSquireApprovalDecision',
          {
            roomId: target,
            requestId: target === room ? request : 'd'.repeat(64),
            approvalId: `proof-${target}`,
            status: 'approved',
            tool: 'fetch_credential',
            title: 'Credential access approval',
            detail: 'Reveal test credential',
          },
          agent,
        );
      const resumes = (
        await db.query(
          `SELECT id,room_id,turn_request_id FROM agent_commands WHERE action='resume'`,
        )
      ).rows;
      for (const resume of resumes) {
        await claimAgentCommand(db, resume.room_id, agent, resume.id, 'proof-resumed');
        await daemon.execute(
          'postRoomMessage',
          {
            roomId: resume.room_id,
            requestId: resume.turn_request_id,
            generationId: 'proof-resumed',
            text: 'Test credential request continued.',
          },
          agent,
        );
      }
      decided = true;
    }
    const result = await snapshot();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result));
    if (decided) process.stdout.write(`R-SQUIRE-ROOM ${JSON.stringify(result)}\n`);
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});
server.listen(18740, '127.0.0.1', () =>
  process.stdout.write('Approval proof listening on 18740\n'),
);
