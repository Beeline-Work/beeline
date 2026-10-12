import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/src/database.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { ensureSystemDirectMessageRoom, systemLine } from '../apps/server/src/system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

async function main() {
const db = new PgliteDatabase();
await migrate(db);
const owner = '1'.repeat(64), agent = 'a'.repeat(64);
const workspaceId = '11111111-1111-4111-8111-111111111111';
const roomId = '22222222-2222-4222-8222-222222222222';
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reviewer','reviewer'),($2,'agent','Hoots','hoots')`, [owner, agent]);
await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline Review')`, [workspaceId]);
await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Review')`, [roomId, workspaceId]);
await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
  VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspaceId, owner, agent, roomId]);
const dm = await ensureSystemDirectMessageRoom(db, workspaceId, owner);
for (const [i, target] of ['npm test', 'git status'].entries()) {
  const grantId = `${i + 3}`.repeat(8) + '-3333-4333-8333-333333333333';
  await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
    VALUES($1,$2,$3,'command',$4,'Check the proposed change',$5,$6,'pending')`, [grantId, agent, workspaceId, target, owner, roomId]);
  await systemLine(db, { roomId: dm, authorId: SYSTEM_IDENTITY_ID,
    subject: { kind: 'agent', id: agent, name: 'Hoots' }, verb: 'asked', object: `to run ${target}`,
    presentation: 'card', cardType: 'grant-request', card: { agent: { pubkey: agent, kind: 'agent', name: 'Hoots' },
      grants: [{ grantId, kind: 'command', target, reason: 'Check the proposed change', status: 'pending' }] } });
}
const phone = new PhoneService(db, 'http://127.0.0.1:39197');
const trace: unknown[] = [];
const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  try {
    if (req.url === '/needs') { res.end(JSON.stringify(await phone.execute('readNeedsYou', { workspaceId }, owner))); return; }
    if (req.url === '/decision' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      const result = await phone.execute('decideAgentGrant', input, owner);
      trace.push({ operation: 'decideAgentGrant', input, result });
      await writeFile('evidence/one-system-thread/decisions.json', JSON.stringify({ workspace: 'Beeline Review', roomId: dm, trace,
        grants: (await db.query('SELECT target,status FROM agent_grants ORDER BY target')).rows }, null, 2));
      res.end(JSON.stringify(result)); return;
    }
    res.statusCode = 404; res.end('{}');
  } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: String(error) })); }
});
server.listen(39197, '127.0.0.1', () => console.log('Isolated Beeline Review tray fixture listening on 39197'));

}
void main();
