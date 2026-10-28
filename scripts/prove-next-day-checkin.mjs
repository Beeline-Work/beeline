import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { NextDayCheckin, checkinDueAt } from '../apps/server/dist/next-day-checkin.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { claimAgentCommand, readAgentCommands } from '../apps/server/dist/agent-command.js';
import { PushDeliveryLoop } from '../apps/server/dist/background.js';

// Isolated service proof: PGlite replaces PostgreSQL; a deterministic helper reply
// replaces a live model, and fake provider transports capture push/email.
const W='11111111-1111-4111-8111-111111111111',R='22222222-2222-4222-8222-222222222222';
const U='a'.repeat(64),A='b'.repeat(64),M='c'.repeat(64);
process.env.BEELINE_NEXT_DAY_CHECKIN='on';
const db=new PgliteDatabase(), live=new LiveHub();
const emails=[];
const capture=createServer(async(request,response)=>{
  let bytes=''; for await(const part of request) bytes+=part;
  emails.push({method:request.method,url:'https://api.resend.com/emails',body:JSON.parse(bytes),
    idempotencyKey:request.headers['idempotency-key']});
  response.writeHead(200,{'content-type':'application/json'}); response.end('{"id":"captured-local-email"}');
});
await new Promise(resolve=>capture.listen(0,'127.0.0.1',resolve));
const originalFetch=globalThis.fetch;
globalThis.fetch=(url,init)=>{
  assert.equal(String(url),'https://api.resend.com/emails');
  return originalFetch(`http://127.0.0.1:${capture.address().port}/emails`,init);
};
process.env.BEELINE_EMAIL_API_KEY='local-proof-key';
process.env.BEELINE_EMAIL_FROM='Beeline <hello@example.test>';
const out = new URL('../docs/evidence/next-day-checkin/',import.meta.url);
try {
  await migrate(db);
  await db.query(`INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery','2026-01-01')`);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Outside','outside'),($2,'agent','Beebee','beebee')`,[U,A]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[A,U]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Pottery class')`,[W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`,[R,W]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
    ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member')`,[W,R,U,A]);
  await db.query(`INSERT INTO free_agents(agent_id,owner_id,workspace_id,sealed_keys,starter_role) VALUES($1,$2,$3,'unused','beebee')`,[A,U,W]);
  await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('google','outside',$1,'google','app','outside@example.test')`,[U]);
  await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
    VALUES('proof-device',$1,'ios','physical','2026-01-01')`,[U]);
  const phone=new PhoneService(db,'https://web.usebeeline.app',undefined,undefined,live);
  await phone.execute('sendRoomMessage',{roomId:R,messageId:M,text:'Help me plan a pottery class'},U);
  const first=new Date('2026-10-26T20:00:00Z');
  await db.query(`UPDATE messages SET created_at=$2 WHERE id=$1`,[M,first]);
  await db.query(`UPDATE next_day_checkin_candidates SET first_at=$2,due_at=$3 WHERE identity_id=$1`,[U,first,checkinDueAt(first)]);
  let clock=new Date('2026-10-27T12:59:00Z');
  const worker=()=>new NextDayCheckin(db,'https://web.usebeeline.app',undefined,()=>clock);
  await worker().runOnce(); assert.equal((await db.query(`SELECT 1 FROM next_day_checkins`)).rowCount,0);
  clock=new Date('2026-10-27T13:00:00Z'); await worker().runOnce();
  const commands=await readAgentCommands(db,R,A);
  const command=commands.commands.find(c=>c.reason==='free_agent_checkin');
  assert.ok(command); assert.match(command.source.body,/only this Room's visible messages/); assert.ok(!command.private);
  assert.equal(emails.length,0);
  await claimAgentCommand(db,R,A,command.id,'proof');
  const text='@outside We were planning your pottery class. Shall we pick the first project?';
  await new DaemonService(db,live).execute('postRoomMessage',{roomId:R,requestId:command.turnRequestId,generationId:'proof',text},A);
  await worker().runOnce();
  const view=await phone.readRoom(R,U); assert.match(JSON.stringify(view),/pick the first project/);
  const push=[];
  // Use the actual push delivery worker; only APNs itself is replaced.
  const delivery=new PushDeliveryLoop(db,undefined,{send:async (...args)=>{push.push(args);}});
  await delivery.runOnce();
  await worker().runOnce(); await worker().runOnce();
  const records=(await db.query(`SELECT identity_id,due_at,sent_at,room_id,agent_id,message_id,email_status,push_outcomes,skip_reason FROM next_day_checkins`)).rows;
  assert.equal(push.length,1);
  assert.equal(records[0].push_outcomes[0].status,'delivered');
  assert.equal(records.length,1); assert.equal(records[0].email_status,'sent'); assert.equal(emails.length,1);
  assert.equal((await db.query(`SELECT 1 FROM messages WHERE request_id=$1 AND author_id=$2`,[command.turnRequestId,A])).rowCount,1);
  await mkdir(out,{recursive:true});
  await writeFile(new URL('email.html',out),emails[0].body.html);
  await writeFile(new URL('proof.json',out),JSON.stringify({feature:'next-day-checkin',classification:'not a defect report',
    standIns:['PGlite database','deterministic helper reply instead of live model','captured email and push providers'],
    visibleMessage:text,command:{reason:command.reason,prompt:command.source.body},records,emails,push},null,2)+'\n');
  console.log(JSON.stringify({roomMessage:text,records,emails:emails.length,pushes:push.length}));
} finally { globalThis.fetch=originalFetch; await new Promise(resolve=>capture.close(resolve)); await db.close(); }
