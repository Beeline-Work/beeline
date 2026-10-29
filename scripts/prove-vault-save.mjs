// Isolated proof server. No production Beeline database or daemon lifecycle is used.
import { createServer } from 'node:http';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { createAgentCommand, claimAgentCommand } from '../apps/server/dist/agent-command.js';
import { vaultSaveHttp } from '../apps/server/dist/vault-save-http.js';
import { VaultSaveRelay } from '../apps/server/dist/vault-save-relay.js';
import { storeVaultSubmission } from '../apps/body/dist/vault-save.js';
import { StdioSquireMcpClient } from '../apps/body/dist/squire-mcp-client.js';

const agentId = '7eafb2e0cc049a9b3345f4322024b604358af04cb551d1fc71084ca3a99d7877';
const ownerId = 'b'.repeat(64);
const workspaceId = '11111111-1111-4111-8111-111111111111';
const roomId = '22222222-2222-4222-8222-222222222222';
const sourceId = 'd'.repeat(64);
const db = new PgliteDatabase();
await migrate(db);
await db.query(
  `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Jellybean'),($2,'human','lunchboxfortwo')`,
  [agentId, ownerId],
);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Vault proof')`, [workspaceId]);
await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Vault proof')`, [
  roomId,
  workspaceId,
]);
await db.query(
  `INSERT INTO agents(agent_id,owner_id,harness,machine_name) VALUES($1,$2,'codex','squire')`,
  [agentId, ownerId],
);
for (const person of [agentId, ownerId])
  for (const room of [null, roomId])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [workspaceId, room, person],
    );
await db.query(
  `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Post a Save to vault card')`,
  [sourceId, roomId, ownerId],
);
const command = await createAgentCommand(db, {
  roomId,
  agentId,
  sourceMessageId: sourceId,
  reason: 'human_tag',
  turnRequestId: sourceId,
});
await claimAgentCommand(db, roomId, agentId, command.id, 'vault-proof');
const live = new LiveHub();
const daemon = new DaemonService(db, live);
const result = await daemon.execute(
  'postVaultSaveCard',
  {
    roomId,
    requestId: sourceId,
    generationId: 'vault-proof',
    taskId: command.root_command_id,
    service: 'beeline-vault-card-test',
    label: 'corner-c2c18ba268d2',
    purpose: 'Throwaway end-to-end vault card test; delete after proof',
    fields: [
      { name: 'login', label: 'Email', secret: false },
      { name: 'password', label: 'Password', secret: true },
    ],
    allowedHosts: ['example.com'],
    authStrategy: 'username_password',
  },
  agentId,
);
const cardId = result.id;
const relay = new VaultSaveRelay();
const auth = {
  authenticatePhone: async (token) => (token === 'isolated-vault-proof-owner' ? ownerId : null),
  authenticateDaemon: async (token) => (token === 'isolated-vault-proof-helper' ? agentId : null),
};
const phone = new PhoneService(db, 'http://127.0.0.1:43187', undefined, undefined, live);
relay.attach(agentId, (frame) => {
  const client = new StdioSquireMcpClient({
    scope: { agentId, roomId },
    home: '/home/lunchbox',
    log: () => {},
  });
  void storeVaultSubmission(frame, (tool, args) => client.call(tool, args))
    .then((answer) => relay.answer(agentId, frame.attemptId, answer))
    .finally(() => client.close());
  return true;
});
const server = createServer((request, response) => {
  if (request.url === '/proof/card') {
    void db.query(`SELECT card FROM messages WHERE id=$1`, [cardId]).then((result) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      response.end(JSON.stringify({ cardId, roomId, ownerId, card: result.rows[0].card }));
    });
    return;
  }
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'authorization,content-type');
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  void vaultSaveHttp(request, response, { auth, database: db, phone, live }, relay);
});
server.listen(43187, '127.0.0.1', () =>
  console.log('Vault proof ready on port (43187); real Squire store, isolated Beeline rows.'),
);
process.once('SIGTERM', () => {
  server.close();
  void db.close();
});
