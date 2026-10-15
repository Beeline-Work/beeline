import { writeFile } from 'node:fs/promises';
import { migrate } from '../apps/server/src/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { systemLine } from '../apps/server/src/system-line.js';

const db = new PgliteDatabase();
try {
  await migrate(db);
  const viewer = 'a'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','System')`, [viewer]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Proof')`, [room, workspace, viewer]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,NULL,$3,'owner')`, [workspace, room, viewer]);
  for (const phrase of [
    { cardType: 'squire-approval-decision', subject: { kind: 'system' as const, name: 'Trusty Squire' },
      verb: 'saw no answer to', object: 'Credential access approval', consequence: 'Reveal a saved credential' },
    { cardType: 'workflow-handoff', subject: { kind: 'system' as const, name: 'System' },
      verb: 'handed off', object: 'implement' },
  ]) await systemLine(db, { ...phrase, roomId: room, authorId: viewer, presentation: 'card', card: {} });
  // Reproduce existing history, without changing any live service or posting.
  await db.query(`UPDATE messages SET presentation='card' WHERE room_id=$1`, [room]);
  const view = await new PhoneService(db, 'http://local.test').readRoom(room, viewer);
  if (view?.messages.length !== 2 || view.messages.some(message => message.presentation !== 'system'))
    throw new Error('Legacy notices did not project as system lines');
  await writeFile('apps/mobile/notice-proof/messages.json', JSON.stringify(view.messages, null, 2) + '\n');
  console.log('Reproduction R1: legacy cards read as system lines; native proof fixtures written');
} finally { await db.close(); }
