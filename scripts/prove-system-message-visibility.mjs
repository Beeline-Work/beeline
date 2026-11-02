// Isolated delivery proof; build the server first. Never touches a live database.
import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { ensureSystemIdentity } from '../apps/server/dist/system-line.js';
import { migrate } from '../apps/server/dist/database.js';
import { reportToCommander } from '../apps/server/dist/commander.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

const db = new PgliteDatabase();
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const human = 'a'.repeat(64),
  commander = 'b'.repeat(64),
  worker = 'c'.repeat(64);
try {
  await migrate(db);
  await ensureSystemIdentity(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`,
    [human, commander, worker],
  );
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)', [
    commander,
    worker,
    human,
  ]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'System visibility proof')", [
    workspace,
  ]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,created_by,parent_id) VALUES
    ($1,$3,'Room',$4,NULL),($2,$3,'Corner',$5,$1)`,
    [room, corner, workspace, human, commander],
  );
  for (const identity of [human, commander, worker]) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,$3,$2,'member')`,
      [workspace, identity, room],
    );
  }
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,worker_agent_id,commissioned_by,objective)
    VALUES($1,$2,$2,$3,'System visibility proof')`,
    [corner, worker, human],
  );
  const phone = new PhoneService(db, 'http://isolated-proof');
  const privateText = 'blocked: Private idle notice';
  const flags = { automatic: true, agentOnly: true };
  const delivered = await db.transaction((tx) =>
    reportToCommander(
      tx,
      corner,
      SYSTEM_IDENTITY_ID,
      privateText,
      undefined,
      'private-agent-report',
      flags,
    ),
  );
  assert.equal(delivered.delivered, true);
  const commands = await db.query('SELECT private_payload FROM agent_commands WHERE id=$1', [
    'private-agent-report',
  ]);
  assert.equal(commands.rows[0]?.private_payload.text, privateText);
  assert.equal((await db.query('SELECT id FROM messages')).rows.length, 0);
  for (const address of [room, corner]) {
    const view = await phone.readRoom(address, human);
    assert.ok(view);
    assert.ok(!JSON.stringify(view).includes(privateText));
  }
  await db.query('UPDATE rooms SET created_by=$2 WHERE id=$1', [corner, human]);
  const skipped = await db.transaction((tx) =>
    reportToCommander(
      tx,
      corner,
      SYSTEM_IDENTITY_ID,
      privateText,
      undefined,
      'private-human-report',
      flags,
    ),
  );
  assert.equal(skipped.skipped, true);
  assert.equal((await db.query('SELECT id FROM messages')).rows.length, 0);
  const visibleText = 'blocked: Visible commander notice';
  await db.transaction((tx) =>
    reportToCommander(
      tx,
      corner,
      SYSTEM_IDENTITY_ID,
      visibleText,
      undefined,
      'visible-human-report',
      { automatic: true },
    ),
  );
  assert.ok(JSON.stringify(await phone.readRoom(room, human)).includes(visibleText));
  console.log(
    'SYSTEM-VISIBILITY-1: built report delivery queues private text only for agents, skips humans, and omits it from phone Room responses; a public report reaches the phone response.',
  );
} finally {
  await db.close();
}
