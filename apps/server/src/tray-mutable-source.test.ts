import {TRAY_SAVED_WINDOW_SCHEMA} from './tray-saved-window.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHOICE_CARD_TYPE } from '@beeline/api-contract/phone';
import type { RouterSnapshot } from '@beeline/api-contract/router-protocol';
import { migratedDatabase, PgliteDatabase } from "../../../tests/helpers/server.js";
import { PhoneService } from './phone-service.js';
import { fenceRouterEnqueue } from './router-projections.js';
import { TRAY_MUTABLE_SOURCE_SCHEMA, readTrayMutableCause } from './tray-mutable-source.js';

const a='a'.repeat(64),b='b'.repeat(64),agent='c'.repeat(64),actor='d'.repeat(64);
const w1='11111111-1111-4111-8111-111111111111',w2='22222222-2222-4222-8222-222222222222';
const r1='33333333-3333-4333-8333-333333333333',r2='44444444-4444-4444-8444-444444444444';
const grant='55555555-5555-4555-8555-555555555555',app='66666666-6666-4666-8666-666666666666';
const choice='77777777-7777-4777-8777-777777777777',offer='88888888-8888-4888-8888-888888888888';
const base = await (async()=>{const db=await migratedDatabase();try{return await db.snapshot();}finally{await db.close();}})();

describe('uninstalled mutable Tray source',()=>{
  let db:PgliteDatabase,phone:PhoneService;
  const input=(workspaceId=w1)=>({family:'needs-you-tray' as const,workspaceId});
  const read=async(viewer=a,workspace=w1)=>await phone.readRouterSnapshot(input(workspace),viewer) as RouterSnapshot<'needs-you-tray'>;
  const causes=async()=> (await db.query<{event:Record<string,unknown>}>(
    `SELECT event FROM live_journal WHERE event->>'sourceTable'='tray-projection' ORDER BY stream_id,sequence`)).rows.map(row=>row.event);
  const resetCauses=()=>db.query(`DELETE FROM live_journal WHERE event->>'sourceTable'='tray-projection'`);
  const epochs=async()=> (await db.query(`SELECT scope,epoch::text FROM router_authority ORDER BY scope`)).rows;
  async function card(id:string,type:string,body:unknown,room=r1){
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES($1,$2,$3,'synthetic card','card',$4,$5::jsonb)`,[id,room,agent,type,JSON.stringify(body)]);
  }
  async function pendingGrant(kind='path',target='/synthetic',appId:string|null=null){
    await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,reason,requested_by,status,app_id)
      VALUES($1,$2,$3,$4,$5,$6,'Synthetic',$7,'pending',$8)`,[grant,agent,w1,r1,kind,target,a,appId]);
    await card('grant-card','grant-request',{agent:{pubkey:agent,name:'Agent'},grants:[{grantId:grant,kind,target}]});
  }
  beforeEach(async()=>{
    db=PgliteDatabase.fromSnapshot(base);
    await db.query(TRAY_MUTABLE_SOURCE_SCHEMA);await db.query(TRAY_SAVED_WINDOW_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Old owner','old'),($2,'human','New owner','new'),($3,'agent','Agent','agent'),($4,'human','Actor','actor')`,[a,b,agent,actor]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,a]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'One'),($2,'Two')`,[w1,w2]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room one'),($2,$4,'Room two')`,[r1,r2,w1,w2]);
    for(const [workspace,room]of[[w1,r1],[w2,r2]])await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      SELECT $1,space,person,'member' FROM unnest(ARRAY[NULL::uuid,$2::uuid])space CROSS JOIN unnest($3::text[])person`,[workspace,room,[a,b,agent]]);
    phone=new PhoneService(db,'https://synthetic.invalid');await resetCauses();
  });
  afterEach(async()=>{await db.close();});

  it('captures both owners before transfer and fences an old complete private projection',async()=>{
    await pendingGrant();const before=await read();expect(before.value.needs.items).toHaveLength(1);
    const untouched=(await db.query(`SELECT sequence::text FROM live_streams WHERE id=$1`,[`workspace:${w2}`])).rows;
    await resetCauses();await db.query(`UPDATE agents SET owner_id=$2 WHERE agent_id=$1`,[agent,b]);
    const changed=await causes();expect(changed.map(cause=>cause.trayReaderId)).toEqual([a,b]);
    expect(changed.every(cause=>cause.trayWorkspaceId===w1&&readTrayMutableCause(cause))).toBe(true);
    expect((await read()).value.needs.items).toHaveLength(0);expect((await read(b)).value.needs.items).toHaveLength(1);
    await expect(fenceRouterEnqueue(db,input(),a,before.authority,()=>undefined)).rejects.toThrow('authority');
    // The shared agent also has a profile and public roster row in Workspace
    // two. Ownership must advance both families, without adding a Tray cause.
    expect((await db.query(`SELECT event->>'sourceTable' family FROM live_journal
      WHERE stream_id=$1 AND sequence>$2 ORDER BY sequence`,[`workspace:${w2}`,untouched[0]!.sequence])).rows)
      .toEqual([{family:'profile-projection'},{family:'roster-projection'}]);
  });

  it('uses the referencing grant Workspace for app ownership and retains cascade tombstones',async()=>{
    await db.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route)
      VALUES($1,$2,$3,'synthetic','Synthetic','registry-mcp','registry-mcp')`,[app,w2,a]);
    await pendingGrant('mcp','connection-install:synthetic',app);await resetCauses();
    await db.query(`UPDATE workspace_apps SET owner_identity_id=$2 WHERE id=$1`,[app,b]);
    expect((await causes()).map(cause=>[cause.trayWorkspaceId,cause.trayReaderId])).toEqual([[w1,a],[w1,b]]);
    const before=await read(b);await resetCauses();await db.query(`DELETE FROM workspace_apps WHERE id=$1`,[app]);
    const deleted=await causes();expect(deleted.some(cause=>cause.table==='workspace_apps'&&cause.oldSourceId===app&&cause.operation==='DELETE')).toBe(true);
    // The parent app's BEFORE capture retains the audience before CASCADE
    // deletes its grants. A child cannot reconstruct an already-deleted app.
    expect((await db.query(`SELECT 1 FROM agent_grants WHERE id=$1`,[grant])).rows).toEqual([]);
    await expect(fenceRouterEnqueue(db,input(),b,before.authority,()=>undefined)).rejects.toThrow('authority');
  });

  it('captures an open choice move using both stored card audiences and closes without a message rewrite',async()=>{
    for(const [id,room,viewer]of[['choice-old',r1,a],['choice-new',r2,b]])await card(id,CHOICE_CARD_TYPE,
      {choiceId:choice,prompt:'Synthetic?',requester:{pubkey:viewer},options:[{optionId:'yes',label:'Yes'}]},room);
    await db.query(`INSERT INTO room_choices(id,workspace_id,room_id,agent_id,message_id,mode,prompt,options,electorate,status)
      VALUES($1,$2,$3,$4,'choice-old','question','Synthetic?','[]'::jsonb,$5::text[],'open')`,[choice,w1,r1,agent,[a]]);
    expect((await read()).value.needs.items).toHaveLength(1);await resetCauses();
    await db.query(`UPDATE room_choices SET workspace_id=$2,room_id=$3,message_id='choice-new' WHERE id=$1`,[choice,w2,r2]);
    expect((await causes()).map(cause=>[cause.trayWorkspaceId,cause.trayReaderId])).toEqual([[w1,a],[w2,b]]);
    expect((await read()).value.needs.items).toHaveLength(0);expect((await read(b,w2)).value.needs.items).toHaveLength(1);
    await resetCauses();await db.query(`UPDATE room_choices SET status='answered' WHERE id=$1`,[choice]);
    expect((await causes()).map(cause=>cause.trayReaderId)).toEqual([b]);
    expect((await read(b,w2)).value.needs.items).toHaveLength(0);
  });

  it('captures connector addressee authority and deletion without relying on a card update',async()=>{
    await card('offer-card','connector-offer',{connectorName:'Synthetic connector'});
    await db.query(`INSERT INTO connector_offers(id,agent_id,workspace_id,room_id,addressee_id,connector_type,reason,machine_id,message_id)
      VALUES($1,$2,$3,$4,$5,'wallet','Synthetic','synthetic-machine','offer-card')`,[offer,agent,w1,r1,a]);
    const before=await read();expect(before.value.needs.items).toHaveLength(1);await resetCauses();
    await db.query(`UPDATE connector_offers SET addressee_id=$2 WHERE id=$1`,[offer,b]);
    expect((await causes()).map(cause=>cause.trayReaderId)).toEqual([a,b]);
    await expect(fenceRouterEnqueue(db,input(),a,before.authority,()=>undefined)).rejects.toThrow('authority');
    expect((await read(b)).value.needs.items).toHaveLength(1);await resetCauses();
    await db.query(`DELETE FROM connector_offers WHERE id=$1`,[offer]);
    expect((await causes()).map(cause=>cause.trayReaderId)).toEqual([b]);expect((await read(b)).value.needs.items).toHaveLength(0);
  });

  it('captures permission decider transfer and the spending agent owner as separate authority sources',async()=>{
    await card('permission-card','permission',{permissionId:'synthetic-permission',requestId:'request',repository:'Synthetic',status:'pending',agent:{pubkey:agent}});
    await db.query(`INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
      VALUES('synthetic-permission',$1,$2,'request','{}'::jsonb,'pending')`,[r1,a]);
    await resetCauses();await db.query(`UPDATE permission_authority SET principal_id=$1 WHERE permission_id='synthetic-permission'`,[b]);
    expect((await causes()).map(cause=>cause.trayReaderId)).toEqual([a,b]);
    await db.query(`UPDATE messages SET card=card||' {"purpose":"squire-spending","tool":"synthetic"}'::jsonb WHERE id='permission-card'`);
    const before=await read();await resetCauses();await db.query(`UPDATE agents SET owner_id=$2 WHERE agent_id=$1`,[agent,b]);
    expect((await causes()).map(cause=>cause.trayReaderId)).toEqual([a,b]);
    await expect(fenceRouterEnqueue(db,input(),a,before.authority,()=>undefined)).rejects.toThrow('authority');
  });

  it('retains a direct grant deletion key and rolls authority/source writes back with a failed mutation',async()=>{
    await pendingGrant();const authority=await epochs();await resetCauses();
    await expect(db.transaction(async tx=>{
      await tx.query(`UPDATE agent_grants SET status='denied' WHERE id=$1`,[grant]);
      throw new Error('synthetic rollback');
    })).rejects.toThrow('synthetic rollback');
    expect(await epochs()).toEqual(authority);expect(await causes()).toEqual([]);
    await db.query(`DELETE FROM agent_grants WHERE id=$1`,[grant]);
    expect(await causes()).toEqual([expect.objectContaining({table:'agent_grants',operation:'DELETE',oldSourceId:grant,trayReaderId:a})]);
    expect((await read()).value.needs.items).toHaveLength(0);
  });

  it('journals reverse Squire decision insert/delete in the approval Workspace with no epoch invalidation',async()=>{
    await card('squire-card','squire-approval',{approvalId:'synthetic-approval',sourceRoomId:r2,title:'Synthetic',tool:'read',
      approvalUrl:'https://synthetic.invalid/approve',expiresAt:Date.now()+60_000});
    expect((await read()).value.needs.items).toHaveLength(1);const authority=await epochs();await resetCauses();
    await card('squire-decision','squire-approval-decision',{approvalId:'synthetic-approval'},r2);
    expect((await causes()).every(cause=>cause.trayWorkspaceId===w1&&cause.table==='messages')).toBe(true);
    expect((await causes()).length).toBeGreaterThan(0);expect(await epochs()).toEqual(authority);
    expect((await read()).value.needs.items).toHaveLength(0);await resetCauses();
    await db.query(`DELETE FROM messages WHERE id='squire-decision'`);
    expect((await causes()).some(cause=>cause.oldMessageId==='squire-decision'&&cause.operation==='DELETE')).toBe(true);
    expect((await read()).value.needs.items).toHaveLength(1);
  });

  it('captures JSON-only actor rename and pre-delete audience without treating display updates as authority',async()=>{
    await card('sign-in-card','agent-sign-in',{ownerId:a,agentId:actor,harness:'claude',status:'pending',expiresAt:Date.now()+60_000});
    expect((await read()).value.needs.items[0]!.approval?.actor).toBe('Actor');
    const authority=(await read()).authority;await resetCauses();await db.query(`UPDATE identities SET name='Renamed actor' WHERE id=$1`,[actor]);
    expect((await causes()).map(cause=>[cause.trayWorkspaceId,cause.trayReaderId])).toEqual([[w1,a]]);
    expect((await read()).value.needs.items[0]!.approval?.actor).toBe('Renamed actor');expect((await read()).authority).toEqual(authority);
    await resetCauses();await db.query(`DELETE FROM identities WHERE id=$1`,[actor]);
    expect((await causes()).some(cause=>cause.table==='identities'&&cause.oldSourceId===actor&&cause.operation==='DELETE')).toBe(true);
    expect((await read()).value.needs.items[0]!.approval?.actor).toBe('Agent');
  });

  it('retains both reader and message keys on private bookmark/mark moves without bumping epochs',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('old-question',$1,$3,'@old please?'),('new-question',$2,$3,'@new please?')`,[r1,r2,agent]);
    await db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at)
      VALUES($1,$2,$3,'old-question','Room one','room',now())`,[a,w1,r1]);
    await db.query(`INSERT INTO needs_you_marks(identity_id,workspace_id,message_id) VALUES($1,$2,'old-question')`,[a,w1]);
    const authority=await epochs();await resetCauses();
    await db.query(`UPDATE message_bookmarks SET identity_id=$1,workspace_id=$2,room_id=$3,message_id='new-question' WHERE identity_id=$4`,[b,w2,r2,a]);
    await db.query(`UPDATE needs_you_marks SET identity_id=$1,workspace_id=$2,message_id='new-question' WHERE identity_id=$3`,[b,w2,a]);
    const changed=await causes();expect(changed).toHaveLength(4);
    for(const event of changed)expect(event).toMatchObject({oldReaderId:a,newReaderId:b,oldMessageId:'old-question',newMessageId:'new-question'});
    expect(new Set(changed.map(cause=>cause.trayWorkspaceId))).toEqual(new Set([w1,w2]));expect(await epochs()).toEqual(authority);
    expect((await read()).value.saved.rows.map(row=>row.value)).toHaveLength(0);expect((await read(b,w2)).value.saved.rows.map(row=>row.value)[0]?.messageId).toBe('new-question');
  });

  it('captures ordinary message key moves for both held bookmark pointers without an authority bump',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('before-key',$1,$2,'Synthetic content')`,[r1,agent]);
    await db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at)
      VALUES($1,$3,$4,'before-key','Synthetic Room','room',now()),($2,$3,$4,'after-key','Synthetic Room','room',now())`,[a,b,w1,r1]);
    const beforeA=await read(),beforeB=await read(b);
    expect(beforeA.value.saved.rows.map(row=>row.value)[0]?.available).toBe(true);expect(beforeB.value.saved.rows.map(row=>row.value)[0]?.available).toBe(false);
    await resetCauses();await db.query(`UPDATE messages SET id='after-key' WHERE id='before-key'`);
    const changed=await causes();expect(changed.map(cause=>cause.trayReaderId)).toEqual([a,b]);
    for(const event of changed)expect(event).toMatchObject({table:'messages',operation:'UPDATE',oldMessageId:'before-key',newMessageId:'after-key',oldRoomId:r1,newRoomId:r1});
    expect(changed.every(cause=>readTrayMutableCause(cause))).toBe(true);
    const afterA=await read(),afterB=await read(b);
    expect(afterA.authority).toEqual(beforeA.authority);expect(afterB.authority).toEqual(beforeB.authority);
    expect(afterA.value.saved.rows.map(row=>row.value)[0]).toMatchObject({messageId:'before-key',available:false});
    expect(afterA.value.saved.rows.map(row=>row.value)[0]).not.toHaveProperty('text');
    expect(afterB.value.saved.rows.map(row=>row.value)[0]).toMatchObject({messageId:'after-key',available:true,text:'Synthetic content'});
  });

  it('ignores hidden-only, usage and ordinary content/seen changes in the added hooks',async()=>{
    await pendingGrant();await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('ordinary',$1,$2,'text')`,[r1,agent]);
    await db.query(`INSERT INTO needs_you_marks(identity_id,workspace_id,message_id) VALUES($1,$2,'ordinary')`,[a,w1]);
    // Other installed features own their own counters (e.g. the Schedules
    // principal domain reads hidden_from_roster). Only Tray's held certificate
    // domains must remain unchanged for these mutations.
    const authority=(await read()).authority;await resetCauses();
    await db.query(`UPDATE identities SET hidden_from_roster=true WHERE id=$1`,[actor]);
    await db.query(`UPDATE agents SET usage_snapshot='{}'::jsonb WHERE agent_id=$1`,[agent]);
    await db.query(`UPDATE messages SET text='new display text',card=jsonb_set(card,'{agent,name}','"Display rename"') WHERE id='grant-card'`);
    await db.query(`UPDATE needs_you_marks SET first_seen_at=clock_timestamp() WHERE message_id='ordinary'`);
    await db.query(`DELETE FROM messages WHERE id='ordinary'`);
    expect((await db.query(`SELECT 1 FROM messages WHERE id='ordinary'`)).rows).toEqual([]);
    expect(await causes()).toEqual([]);expect((await read()).authority).toEqual(authority);
  });

  it('does not journal or advance authority for unused grant Room and offer Workspace bookkeeping',async()=>{
    await pendingGrant();await card('offer-card','connector-offer',{connectorName:'Synthetic wallet'});
    await db.query(`INSERT INTO connector_offers(id,agent_id,workspace_id,room_id,addressee_id,connector_type,reason,machine_id,message_id)
      VALUES($1,$2,$3,$4,$5,'wallet','Synthetic','synthetic-machine','offer-card')`,[offer,agent,w1,r1,a]);
    const before=await read(),authority=before.authority;await resetCauses();
    await db.query(`UPDATE agent_grants SET room_id=$2 WHERE id=$1`,[grant,r2]);
    await db.query(`UPDATE connector_offers SET workspace_id=$2 WHERE id=$1`,[offer,w2]);
    expect(await causes()).toEqual([]);expect((await read()).authority).toEqual(authority);
    expect((await read()).value).toEqual(before.value);
  });

  it('fences changed card recipient keys while a plain embedded actor rename stays a display source',async()=>{
    await card('sign-in-card','agent-sign-in',{ownerId:a,agentId:actor,harness:'claude',status:'pending',expiresAt:Date.now()+60_000});
    const before=await read();await resetCauses();
    await db.query(`UPDATE messages SET card=jsonb_set(card,'{ownerId}',to_jsonb($1::text)) WHERE id='sign-in-card'`,[b]);
    expect((await causes()).map(cause=>cause.trayReaderId)).toEqual([a,b]);
    await expect(fenceRouterEnqueue(db,input(),a,before.authority,()=>undefined)).rejects.toThrow('authority');
    expect((await read(b)).value.needs.items).toHaveLength(1);
  });

  it.each([null,'null'])('keeps null→object→null legacy card writes valid (%s)',async empty=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES('transition',$1,$2,'synthetic','card','agent-sign-in',$3::jsonb)`,[r1,agent,empty]);
    await resetCauses();
    await db.query(`UPDATE messages SET card=$1::jsonb WHERE id='transition'`,[JSON.stringify({ownerId:a,agentId:actor,harness:'claude',status:'pending',expiresAt:Date.now()+60_000})]);
    expect((await read()).value.needs.items).toHaveLength(1);
    expect((await causes()).some(cause=>cause.trayReaderId===a)).toBe(true);
    await resetCauses();
    await db.query(`UPDATE messages SET card=$1::jsonb,card_type=NULL,presentation='message' WHERE id='transition'`,[empty]);
    expect((await db.query<{card:unknown}>(`SELECT card FROM messages WHERE id='transition'`)).rows[0]?.card).toBe(null);
    expect((await read()).value.needs.items).toHaveLength(0);
    expect((await causes()).some(cause=>cause.trayReaderId===a)).toBe(true);
  });
});

it('accepts only bounded closed reader causes and keeps deletion keys',()=>{
  const valid={sourceTable:'tray-projection',trayReaderId:a,trayWorkspaceId:w1,table:'message_bookmarks',operation:'UPDATE',oldMessageId:'old',newMessageId:'new'};
  expect(readTrayMutableCause(valid)).toEqual(valid);
  expect(readTrayMutableCause({...valid,table:'undeclared_table'})).toBeUndefined();
  expect(readTrayMutableCause({...valid,heldWindows:[]})).toBeUndefined();
  expect(readTrayMutableCause({...valid,oldMessageId:'x'.repeat(129)})).toBeUndefined();
});
