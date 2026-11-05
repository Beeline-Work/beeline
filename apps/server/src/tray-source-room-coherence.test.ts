import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHOICE_CARD_TYPE } from '@beeline/api-contract/phone';
import type { RouterSnapshot } from '@beeline/api-contract/router-protocol';
import { migratedDatabase, PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { TRAY_SAVED_WINDOW_SCHEMA } from './tray-saved-window.js';
import { TRAY_MUTABLE_SOURCE_SCHEMA } from './tray-mutable-source.js';

const viewer='a'.repeat(64),privateViewer='b'.repeat(64),agent='c'.repeat(64);
const publicWorkspace='11111111-1111-4111-8111-111111111111',privateWorkspace='22222222-2222-4222-8222-222222222222';
const publicRoom='33333333-3333-4333-8333-333333333333',privateRoom='44444444-4444-4444-8444-444444444444';
const resource='55555555-5555-4555-8555-555555555555';
const base=await(async()=>{const db=await migratedDatabase();try{return await db.snapshot();}finally{await db.close();}})();

describe('Tray resource and message Room coherence',()=>{
  let db:PgliteDatabase,phone:PhoneService;
  const read=async(person=viewer,workspace=publicWorkspace)=>await phone.readRouterSnapshot(
    {family:'needs-you-tray',workspaceId:workspace},person) as RouterSnapshot<'needs-you-tray'>;
  const head=async(workspace:string)=>Number((await db.query<{sequence:string}>(
    `SELECT sequence::text FROM live_streams WHERE id=$1`,[`workspace:${workspace}`])).rows[0]!.sequence);
  beforeEach(async()=>{
    db=PgliteDatabase.fromSnapshot(base);await db.query(TRAY_MUTABLE_SOURCE_SCHEMA);await db.query(TRAY_SAVED_WINDOW_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Public reader'),($2,'human','Private reader'),($3,'agent','Agent')`,[viewer,privateViewer,agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,viewer]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Public scope'),($2,'Private scope')`,[publicWorkspace,privateWorkspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Public Room'),($2,$4,'Private Room')`,[publicRoom,privateRoom,publicWorkspace,privateWorkspace]);
    for(const [workspace,room,person]of[[publicWorkspace,publicRoom,viewer],[privateWorkspace,privateRoom,privateViewer]])
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`,[workspace,room,person]);
    phone=new PhoneService(db,'https://synthetic.invalid');
  });
  afterEach(async()=>{await db.close();});

  it.each(['choice','connector'] as const)('keeps coherent %s cards and hides a raw move that points at a different private message Room',async kind=>{
    for(const [id,room,person]of[['public-card',publicRoom,viewer],['private-card',privateRoom,privateViewer]]){
      const body=kind==='choice'?{choiceId:resource,prompt:'Synthetic decision?',requester:{pubkey:person},options:[{optionId:'yes',label:'Yes'}]}
        :{connectorName:'Synthetic wallet',intent:'add'};
      await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
        VALUES($1,$2,$3,$4,'card',$5,$6::jsonb)`,[id,room,agent,id==='private-card'?'PRIVATE CONTENT':'Public content',
        kind==='choice'?CHOICE_CARD_TYPE:'connector-offer',JSON.stringify(body)]);
    }
    if(kind==='choice')await db.query(`INSERT INTO room_choices(id,workspace_id,room_id,agent_id,message_id,mode,prompt,options,electorate,status)
      VALUES($1,$2,$3,$4,'public-card','question','Synthetic decision?','[]'::jsonb,$5::text[],'open')`,[resource,publicWorkspace,publicRoom,agent,[viewer]]);
    else await db.query(`INSERT INTO connector_offers(id,agent_id,workspace_id,room_id,addressee_id,connector_type,reason,machine_id,message_id)
      VALUES($1,$2,$3,$4,$5,'wallet','Synthetic','synthetic-machine','public-card')`,[resource,agent,publicWorkspace,publicRoom,viewer]);
    expect((await read()).value.needs.items.map(item=>item.messageId)).toEqual(['public-card']);
    const [oldPublic,oldPrivate]=await Promise.all([head(publicWorkspace),head(privateWorkspace)]);
    if(kind==='choice')await db.query(`UPDATE room_choices SET workspace_id=$2,room_id=$3,message_id='private-card' WHERE id=$1`,[resource,privateWorkspace,privateRoom]);
    else await db.query(`UPDATE connector_offers SET workspace_id=$2,room_id=$3,message_id='private-card',addressee_id=$4 WHERE id=$1`,[resource,privateWorkspace,privateRoom,privateViewer]);
    expect(await head(publicWorkspace)).toBeGreaterThan(oldPublic);expect(await head(privateWorkspace)).toBeGreaterThan(oldPrivate);
    expect((await read()).value.needs.items).toEqual([]);
    expect((await read(privateViewer,privateWorkspace)).value.needs.items.map(item=>item.messageId)).toEqual(['private-card']);

    const priorPublic=await head(publicWorkspace),priorPrivate=await head(privateWorkspace);
    await db.query(`DELETE FROM live_journal WHERE event->>'sourceTable'='tray-projection'`);
    // The viewer gains the resource Room, never the actual private message Room.
    // Raw writes must not make the card's Room pointer confer message access.
    if(kind==='choice')await db.query(`UPDATE room_choices SET workspace_id=$2,room_id=$3 WHERE id=$1`,[resource,publicWorkspace,publicRoom]);
    else await db.query(`UPDATE connector_offers SET workspace_id=$2,room_id=$3,addressee_id=$4 WHERE id=$1`,[resource,publicWorkspace,publicRoom,viewer]);
    const result=await read();expect(result.value.needs.items).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE CONTENT');
    expect((await db.query(`SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,[privateRoom,viewer])).rows).toEqual([]);
    if(kind==='choice')expect(await head(publicWorkspace)).toBe(priorPublic);
    else expect(await head(publicWorkspace)).toBeGreaterThan(priorPublic);
    expect(await head(privateWorkspace)).toBeGreaterThan(priorPrivate);
    const causes=(await db.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal
      WHERE event->>'sourceTable'='tray-projection' ORDER BY stream_id,sequence`)).rows.map(row=>row.event);
    expect(causes.some(cause=>cause.trayWorkspaceId===privateWorkspace&&cause.oldRoomId===privateRoom&&cause.oldMessageId==='private-card')).toBe(true);
    if(kind==='choice'){
      // The private card still addresses B, who has no public Room access.
      // Moving its resource pointer creates no public A audience or read.
      expect(causes.some(cause=>cause.trayWorkspaceId===publicWorkspace)).toBe(false);
      expect(causes.some(cause=>cause.trayReaderId===viewer)).toBe(false);
    }else expect(causes.some(cause=>cause.trayWorkspaceId===publicWorkspace&&cause.newRoomId===publicRoom&&cause.newMessageId==='private-card')).toBe(true);
  });
});
