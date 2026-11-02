import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase } from './test-support.js';
import { appendHelperOverlay, type HelperOverlayFrame } from '@beeline/api-contract/helper-overlay';
import { HELPER_OVERLAY_SCHEMA, HelperOverlayViewer, applyHelperOverlay, fenceHelperOverlayEnqueue, helperOverlayDemand, type HelperOverlayLiveEvent } from './helper-overlay.js';
const room='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222';
const identity={agentId:'agent',roomId:room,commandId:'command',turnId:'turn',turnGeneration:'generation',runGeneration:0,kind:'draft' as const};
const frame=(input:Partial<HelperOverlayFrame>={}):HelperOverlayFrame=>({...identity,v:1,type:'baseline',revision:1,offset:0,text:'🌍',viewingRevision:1,...input});
const owner={connectionId:'connection',epoch:1};

describe('helper overlay source ownership and final enqueue',()=>{
  let db:PgliteDatabase;
  beforeAll(async()=>{
    db=new PgliteDatabase();
    await db.query(`CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,archived_at timestamptz);
      CREATE TABLE room_access(room_id uuid,identity_id text,removed_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
      CREATE TABLE room_push_views(room_id uuid,identity_id text,session_id text,instance_id text,expires_at timestamptz);
      CREATE TABLE live_server_instances(instance_id text,renewed_at timestamptz);
      CREATE TABLE agent_connections(agent_id text,connection_id text,epoch bigint,released_at timestamptz);
      CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,turn_request_id text,action text,generation_id text,state text,created_at timestamptz DEFAULT now());
      CREATE TABLE agent_turns(room_id uuid,agent_id text,request_id text,generation_id text,status text);
      CREATE TABLE live_outputs(room_id uuid,agent_id text,turn_id text,kind text,body jsonb,updated_at timestamptz DEFAULT now(),PRIMARY KEY(room_id,agent_id,turn_id,kind));`);
    await db.query(HELPER_OVERLAY_SCHEMA);
    await db.query(`INSERT INTO rooms VALUES($1,$2,NULL)`,[room,workspace]);
    await db.query(`INSERT INTO room_access VALUES($1,'agent',NULL),($1,'reader',NULL)`,[room]);
    await db.query(`INSERT INTO memberships VALUES($1,NULL,'agent','member',NULL),($1,NULL,'reader','member',NULL)`,[workspace]);
    await db.query(`INSERT INTO room_push_views VALUES($1,'reader','session',NULL,NULL)`,[room]);
    await db.query(`INSERT INTO agent_connections VALUES('agent','connection',1,NULL);
      INSERT INTO agent_turns VALUES('${room}','agent','turn','generation','working');
      INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,generation_id,state) VALUES('command','${room}','agent','turn','input','generation','claimed');`);
  },30000);
  afterAll(async()=>{await db.close();});
  it('validates UTF-8 offsets, monotone revision/run generation, and stale baseline rejection',async()=>{
    expect((await applyHelperOverlay(db,'agent',owner,frame())).ack).toEqual({accepted:true,revision:1});
    expect((await applyHelperOverlay(db,'agent',owner,frame({type:'append',revision:2,offset:2,text:'é'}))).ack).toEqual({accepted:false,reason:'gap'});
    expect((await applyHelperOverlay(db,'agent',owner,frame({type:'append',revision:2,offset:4,text:'é'}))).ack).toEqual({accepted:true,revision:2});
    expect((await db.query<{body:{text:string}}>('SELECT body FROM live_outputs')).rows[0]?.body.text).toBe('🌍é');
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:1,text:'older'}))).ack).toEqual({accepted:false,reason:'stale'});
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:3,runGeneration:1,text:'fresh'}))).ack).toEqual({accepted:true,revision:3});
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:4,runGeneration:0,text:'late old run'}))).ack).toEqual({accepted:false,reason:'stale'});
    expect(appendHelperOverlay('🌍',2,'x')).toBeUndefined();expect(appendHelperOverlay('',0,'\ud800')).toBeUndefined();
  });
  it('requires a new helper baseline for a changed actual viewer source and refuses zero-viewer writes',async()=>{
    await db.query(`DELETE FROM room_push_views`);expect((await helperOverlayDemand(db,room)).viewing).toBe(false);
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:4,runGeneration:1}))).ack).toEqual({accepted:false,reason:'unviewed'});
    await db.query(`INSERT INTO room_push_views VALUES($1,'reader','fresh-session',NULL,NULL)`,[room]);
    const demand=await helperOverlayDemand(db,room);expect(demand.viewingRevision).toBe(3);
    expect((await applyHelperOverlay(db,'agent',owner,frame({type:'append',revision:4,runGeneration:1,offset:5,text:'x',viewingRevision:3}))).ack).toEqual({accepted:false,reason:'gap'});
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:4,runGeneration:1,text:'fresh-view',viewingRevision:3}))).ack).toEqual({accepted:true,revision:4});
  });
  it('checks current helper connection and reader authority through synchronous enqueue',async()=>{
    const result=await applyHelperOverlay(db,'agent',owner,frame({revision:5,runGeneration:1,text:'current',viewingRevision:3}));
    const enqueue=vi.fn();await fenceHelperOverlayEnqueue(db,result.event!,enqueue,'reader');expect(enqueue).toHaveBeenCalledOnce();
    await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id='reader'`);
    await fenceHelperOverlayEnqueue(db,result.event!,enqueue,'reader');expect(enqueue).toHaveBeenCalledOnce();
    await db.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id='reader'`);
    await db.query(`UPDATE agent_connections SET epoch=2,connection_id='replacement'`);
    await fenceHelperOverlayEnqueue(db,result.event!,enqueue,'reader');expect(enqueue).toHaveBeenCalledOnce();
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:6,runGeneration:1,viewingRevision:5}))).ack).toEqual({accepted:false,reason:'stale'});
    await db.query(`UPDATE agent_connections SET epoch=1,connection_id='connection'`);
  });
  it('keeps an end tombstone and durable terminal state prevents late resurrection',async()=>{
    const viewingRevision=(await helperOverlayDemand(db,room)).viewingRevision;
    // A new viewing revision requires a current baseline before the terminal frame.
    await applyHelperOverlay(db,'agent',owner,frame({revision:6,runGeneration:1,viewingRevision}));
    expect((await applyHelperOverlay(db,'agent',owner,frame({type:'end',revision:7,runGeneration:1,text:'',viewingRevision}))).ack).toEqual({accepted:true,revision:7});
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:8,runGeneration:1,viewingRevision}))).ack).toEqual({accepted:false,reason:'stale'});
    await db.query(`UPDATE agent_commands SET state='complete';UPDATE agent_turns SET status='complete'`);
    const enqueue=vi.fn(),body=(await db.query<{body:Record<string,unknown>}>('SELECT body FROM live_outputs')).rows[0]!.body;
    const {helperOverlayEvent}=await import('./helper-overlay.js');await fenceHelperOverlayEnqueue(db,helperOverlayEvent(body)!,enqueue,'reader');expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('phone fresh-helper viewing barrier',()=>{
  const event=(revision:number,viewingRevision:number,type:HelperOverlayFrame['type']='baseline'):HelperOverlayLiveEvent=>({type:'draft',roomId:room,agentId:'agent',turnId:'turn',text:'current',
    overlayV1:{...frame({revision,viewingRevision,type}),text:'',connectionId:'connection',connectionEpoch:1}});
  it('buffers one actual fresh baseline before viewing commit and rejects stale snapshots or late revisions',()=>{
    const enqueue=vi.fn(),viewer=new HelperOverlayViewer(value=>{enqueue(value);viewer.delivered(value);});viewer.enter(room);
    expect(viewer.accept(event(5,3))).toBe(false);viewer.commit(room,3);expect(enqueue).toHaveBeenCalledOnce();
    expect(viewer.accept(event(4,3))).toBe(false);expect(viewer.accept(event(6,3,'append'))).toBe(true);
    viewer.delivered(event(6,3,'append'));
    expect(viewer.normalize(event(9,3,'append'))).toMatchObject({overlayV1:{type:'replace',offset:0}});
    viewer.leave(room);expect(viewer.accept(event(7,3,'append'))).toBe(false);
    viewer.enter(room);viewer.commit(room,4);expect(viewer.accept(event(6,3))).toBe(false);
    expect(viewer.accept(event(8,4,'append'))).toBe(false);expect(viewer.accept(event(9,4))).toBe(true);
    // An accepted baseline denied by the final DB/socket fence is not delivered.
    expect(viewer.accept(event(10,4,'append'))).toBe(false);
    viewer.delivered(event(9,4));expect(viewer.accept(event(10,4,'append'))).toBe(true);
  });
  it('retains multiple pre-view baselines and a latest append until its baseline actually enqueues',async()=>{
    const enqueued:HelperOverlayLiveEvent[]=[];
    const viewer=new HelperOverlayViewer(value=>{enqueued.push(value);});
    viewer.enter(room);
    const first=event(1,1),second={...event(1,1),agentId:'agent-2',overlayV1:{...event(1,1).overlayV1,agentId:'agent-2'}} as HelperOverlayLiveEvent;
    viewer.accept(first);viewer.accept(second);viewer.commit(room,1);expect(enqueued).toHaveLength(2);
    expect(viewer.accept(event(2,1,'append'))).toBe(false);expect(enqueued).toHaveLength(2);
    viewer.delivered(first);await Promise.resolve();expect(enqueued).toHaveLength(3);
    expect(enqueued[2]?.overlayV1.revision).toBe(2);viewer.delivered(enqueued[2]!);
    // An older fence that completes after revision2 must not paint backwards.
    expect(viewer.canDeliver(first)).toBe(false);
  });

  it('refuses a physically oversized canonical phone frame before any final DB query or enqueue',async()=>{
    const enqueue=vi.fn(),query=vi.fn(),transaction=vi.fn();
    const oversized={...event(1,1),text:'\u0000'.repeat(50_000)} as HelperOverlayLiveEvent;
    await fenceHelperOverlayEnqueue({query,transaction},oversized,enqueue,'reader');
    expect(query).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();
  });

});
