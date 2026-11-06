// Run after building Body and server. Uses an isolated in-memory database.
import assert from 'node:assert/strict';
import { roomReplySteps } from '../apps/body/dist/room-turn-steps.js';
import { migrate } from '../apps/server/dist/database.js';
import { PgliteDatabase } from '../apps/server/dist/test-support.js';
import { readRoomTools } from '../apps/server/dist/room-tool-projection.js';

const db = new PgliteDatabase();
const viewer = 'a'.repeat(64);
const agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const message = 'c'.repeat(64);
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader'),($2,'agent','Writer')`, [viewer, agent]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'proof')`, [room, workspace, viewer]);
  await db.query(`INSERT INTO memberships(room_id,workspace_id,identity_id,role) VALUES($1,$2,$3,'member'),(NULL,$2,$3,'member')`, [room, workspace, viewer]);
  const activity = roomReplySteps([
    {kind:'tool',call:{title:'read_file',content:[{type:'text',text:'file contents\ntoken=planted-secret\n'+'x'.repeat(5000)}]}},
    {kind:'tool',call:{title:'fetch_credential',content:'planted-secret'}},
    {kind:'tool',call:{title:'old empty row'}},
    ...['.netrc', '_netrc'].map(filename => ({kind:'tool',call:{title:'read_file',rawInput:{path:`/synthetic/${filename}`},content:'machine example.invalid login synthetic password planted-netrc-password'}})),
    ...['password', 'passwd'].flatMap(keyword => [' ', '\n'].map(separator => ({kind:'tool',call:{title:'exec_command',content:['machine example.invalid','login planted-netrc-login',keyword,'planted-netrc-password'].join(separator)}}))),
    {kind:'tool',call:{title:'exec_command',rawInput:{cmd:"sed -n '1,10p' /synthetic/.pgpass"},content:'example.invalid:5432:synthetic:reader:planted-pgpass-password'}},
  ], {pubkey:viewer,name:'Reader'});
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,activity) VALUES($1,$2,$3,'','activity',$4::jsonb)`, [message,room,agent,JSON.stringify(activity)]);
  const list = await readRoomTools(db,{roomId:room,anchor:message},viewer);
  assert(list.messages[0].activity.every(row=>!Object.hasOwn(row,'output')));
  const tapped = await readRoomTools(db,{roomId:room,anchor:message,messageId:message},viewer);
  const [output,secret,empty] = tapped.messages[0].activity;
  assert(output.output.startsWith('file contents\n'));
  assert(!output.output.includes('planted-secret'));
  assert(Buffer.byteLength(output.output)<=4096);
  assert(output.output.endsWith('[cut off]'));
  assert.equal(secret.output,'Output hidden: contains a secret.');
  assert.equal(empty.output,undefined);
  const pgpassRow = tapped.messages[0].activity.at(-1);
  assert.equal(pgpassRow.output,'Output hidden: contains a secret.');
  assert(!JSON.stringify(tapped).includes('planted-pgpass-password'));
  const netrcRows = tapped.messages[0].activity.slice(3,-1);
  assert(!JSON.stringify(netrcRows).includes('planted-netrc-password'));
  assert(!JSON.stringify(netrcRows).includes('planted-netrc-login'));
  assert(netrcRows.slice(0,2).every(row=>row.output==='Output hidden: contains a secret.'));
  assert(netrcRows.slice(2).every(row=>row.output.includes('[REDACTED]')));
  console.log('TOOL-OUTPUT-1 PASS: stored redacted output is readable on tap; lists omit bodies; secret and empty calls have safe states.');
  console.log('TOOL-OUTPUT-NETRC-1 PASS: tapped persisted credential reads are hidden; single-line and multiline netrc passwords are redacted.');
  console.log('TOOL-OUTPUT-SED-PGPASS-1 PASS: synthetic sed credential output is hidden through Body, isolated persistence and production tap projection.');
} finally {
  await db.close();
}
