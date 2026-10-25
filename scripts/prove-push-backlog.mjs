import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { migrate } from '../apps/server/dist/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
const { PushDeliveryLoop } = await import(process.env.BEELINE_PUSH_PROOF_WORKER
  ? pathToFileURL(process.env.BEELINE_PUSH_PROOF_WORKER).href
  : '../apps/server/dist/background.js');

// Isolated provider-boundary proof: no device token or production connection.
const db = new PgliteDatabase();
try {
  await migrate(db);
  const owner = 'a'.repeat(64), peer = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  const dm = '33333333-3333-4333-8333-333333333333';
  await db.query(`INSERT INTO identities(id,kind,name,handle,push_level)
    VALUES($1,'human','Owner','owner','attention'),($2,'human','Peer','peer','attention')`,[owner,peer]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Push proof')`,[workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants)
    VALUES($1,$3,'Room',NULL),($2,$3,'DM',$4::jsonb)`,[room,dm,workspace,JSON.stringify([owner,peer])]);
  for (const channel of [room,dm]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`,[workspace,channel,owner,peer]);
  }
  await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
    VALUES('isolated-proof-device',$1,'android','physical',now()-interval '1 day')`,[owner]);
  await db.query(`INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery',now()-interval '1 day')`);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type)
    SELECT 'noise-'||n,$1,$2,'GitHub updated','system','github-corner-note' FROM generate_series(1,200) n`,[room,peer]);
  // Seed rows left by the previous enqueue policy, even after new writes are filtered.
  await db.query(`INSERT INTO push_outbox(message_id,device_token,expires_at)
    SELECT id,'isolated-proof-device',created_at+interval '1 hour' FROM messages WHERE id LIKE 'noise-%'
    ON CONFLICT DO NOTHING`);
  await db.query(`UPDATE push_outbox SET not_before=now()-interval '2 minutes'`);
  await db.query(`INSERT INTO push_outbox(message_id,device_token,not_before,expires_at)
    SELECT 'expired-'||n,'isolated-proof-device',now()-interval '3 minutes',now()-interval '1 second'
    FROM generate_series(1,1100) n`);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('unread-dm',$1,$2,'Hello from your DM')`,[dm,peer]);
  const sent = [];
  const began = performance.now();
  const delivered = await new PushDeliveryLoop(db,{send:async (_token,message)=>{sent.push(message);}}).runOnce();
  const elapsed = performance.now()-began;
  const remaining = Number((await db.query(`SELECT count(*) remaining FROM push_outbox`)).rows[0].remaining);
  console.info(JSON.stringify({reproduction:'R-PUSH-BACKLOG',delivered,remaining,elapsedMs:elapsed,
    processedRowsPerSecond:(1301-remaining)/(elapsed/1000),providerMessageIds:sent.map(m=>m.messageId)}));
  assert.equal(delivered,1,'Unread DM must reach the provider in the first worker cycle');
  assert.equal(remaining,0,'Expired and ineligible work must drain');
  assert.equal(sent[0].messageId,'unread-dm');
  assert.equal(sent[0].title,'@peer');
  // BEELINE-SERVER-17: production's remaining backlog is preference-ineligible prose.
  await db.query(`INSERT INTO messages(id,room_id,author_id,text)
    SELECT 'preference-'||n,$1,$2,'Ordinary conversation' FROM generate_series(1,1100) n`,[room,peer]);
  const loop = new PushDeliveryLoop(db,{send:async (_token,message)=>{sent.push(message);}});
  await loop.runOnce();
  await loop.runOnce();
  const recurring = Number((await db.query(`SELECT count(*) recurring FROM push_outbox
    WHERE not_before<=now()+interval '65 seconds'`)).rows[0].recurring);
  console.info(JSON.stringify({reproduction:'BEELINE-SERVER-17',retained:1100,recurringAfterOneMinute:recurring}));
  assert.equal(recurring,0,'Preference-ineligible prose must stop competing every minute');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('next-unread-dm',$1,$2,'A fresh DM')`,[dm,peer]);
  assert.equal(await loop.runOnce(),1,'Fresh unread DM must pass parked prose in one cycle');
  assert.equal(sent.at(-1).messageId,'next-unread-dm');
  await db.query(`UPDATE messages SET text='@owner please read this' WHERE id='preference-1'`);
  assert.equal(await loop.runOnce(),1,'Editing parked prose into a mention must reach the provider');
  assert.equal(sent.at(-1).messageId,'preference-1');
  await db.query(`UPDATE messages SET text='Ordinary conversation again' WHERE id='preference-1'`);
  assert.equal(await loop.runOnce(),0,'Removing a delivered mention must not resend it');
  await db.query(`UPDATE messages SET text='@owner mention again' WHERE id='preference-1'`);
  assert.equal(await loop.runOnce(),0,'Re-adding a delivered mention must not resend it');
  assert.equal(sent.filter(message=>message.messageId==='preference-1').length,1,
    'Edited mention must reach the provider exactly once');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('retry-edit',$1,$2,'@owner retry')`,[room,peer]);
  await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status,next_retry_at)
    VALUES('retry-edit','isolated-proof-device','retryable',now()+interval '5 minutes')`);
  const retryBefore = (await db.query(`SELECT not_before FROM push_outbox WHERE message_id='retry-edit'`)).rows;
  await db.query(`UPDATE messages SET text='@owner edited retry' WHERE id='retry-edit'`);
  assert.deepEqual((await db.query(`SELECT not_before FROM push_outbox WHERE message_id='retry-edit'`)).rows,retryBefore,
    'Message edits must preserve provider retry deadlines');
  assert.equal(await loop.runOnce(),0,'Provider retry must stay asleep after editing');
  console.info(JSON.stringify({reproduction:'BEELINE-SERVER-17',editedMentionDelivered:true,alreadyDeliveredNotResent:true,providerRetryPreserved:true}));
  await db.query(`UPDATE identities SET push_level='full' WHERE id=$1`,[owner]);
  const woken = Number((await db.query(`SELECT count(*) woken FROM push_outbox WHERE not_before<=now() AND message_id LIKE 'preference-%'`)).rows[0].woken);
  assert.equal(woken,1099,'Preference change must wake retained messages');
  await loop.runOnce();
  await loop.runOnce();
  assert.ok(sent.some(message=>message.messageId.startsWith('preference-')),'Retained prose reaches provider after preference change');
  console.info(JSON.stringify({reproduction:'BEELINE-SERVER-17',freshDmDelivered:true,preferenceRowsWoken:woken,preferenceDelivery:true}));
} finally { await db.close(); }
