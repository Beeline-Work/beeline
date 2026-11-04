import { validateTrayProjection } from '../../../packages/net/src/private/owner-inputs.js';
import { postRoomChoice, answerRoomChoice } from './room-choice.js';
import {RouterBuildCoordinator} from './router-build-coordinator.js';
import {TrayClockAvailability} from './tray-clock-availability.js';
import {BACKGROUND_OWNERSHIP_SCHEMA,BackgroundOwnership} from './background-ownership.js';
import {TRAY_CLOCK_OWNER_SCHEMA} from './tray-clock-owner.js';
import {TrayClockHealth} from './tray-clock-health.js';
import {readTrayClockBasis} from './tray-clock-basis.js';
import {installBackgroundOwnerTestProof,backgroundOwnerTestLock} from './test-fixtures/background-owner-test-support.js';
import {TrayClockReadiness} from './tray-clock-readiness.js';
import {TRAY_CLOCK_SOURCE_SCHEMA} from './tray-clock-source.js';
import {TRAY_SAVED_WINDOW_SCHEMA} from './tray-saved-window.js';
import { createHash } from 'node:crypto';
import { ReadLanes } from '../../../packages/net/src/private/read-lanes.js';
import { RouterBatchAssembly } from '../../../packages/net/src/private/batch-assembly.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouterFact } from '@beeline/api-contract/router-protocol';
import { LIVE_REPLAY_BYTE_LIMIT } from './durable-live.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { buildRouterSnapshot, encodeRouterBatch, fenceRouterBatch, fenceRouterEnqueue, readRouterCertificate, RouterProjectionDrain } from './router-projections.js';
import { routerSocketProtocol } from './router-socket.js';
import { routerSourcePlan } from './router-source-plan.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const VIEWER='a'.repeat(64), OTHER='b'.repeat(64);
const WORKSPACE='11111111-1111-4111-8111-111111111111';
const ROOM='22222222-2222-4222-8222-222222222222';
const input={family:'needs-you' as const,workspaceId:WORKSPACE};
describe('router projections: pure coherent cuts and bounded delivery',()=>{
  let database:PgliteDatabase;let releaseHealth=()=>{};let clockLive:LiveHub,clockAvailability:TrayClockAvailability|undefined;
  beforeEach(async()=>{
    database=await migratedDatabase();releaseHealth=()=>{};clockLive=new LiveHub();clockAvailability=undefined;
    await database.query(BACKGROUND_OWNERSHIP_SCHEMA);await database.query(TRAY_CLOCK_OWNER_SCHEMA);
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'human','Other','other')`,[VIEWER,OTHER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,[ROOM,WORKSPACE,VIEWER]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$4,'member')`,[WORKSPACE,ROOM,VIEWER,OTHER]);
  });
  afterEach(async()=>{await clockAvailability?.close();releaseHealth();await database.close();});
  const readyClock=async()=>{
    await database.query(TRAY_CLOCK_SOURCE_SCHEMA);
    const readiness=new TrayClockReadiness(database);await readiness.initialize();await readiness.seed();
    for(let step=0;step<20;step++){if(!await readiness.step())break;if(step===19)throw new Error('Readiness did not finish');}
    await installBackgroundOwnerTestProof(database);const lock=await backgroundOwnerTestLock(database);
    await database.query(`INSERT INTO live_server_instances(instance_id) VALUES('tray-enqueue')`);
    const owner=new BackgroundOwnership(database,'tray-enqueue'),epoch=await owner.claim(lock);
    releaseHealth=()=>owner.revoke(epoch);await new TrayClockHealth(owner).publish(epoch);
    clockAvailability=new TrayClockAvailability(database,clockLive,{listenerReady:()=>true,unavailable:()=>{}});await clockAvailability.start();
    return (await readTrayClockBasis(database,WORKSPACE))!.clockVersion;
  };
  const snapshot=()=>buildRouterSnapshot(database,input,VIEWER,(db,args,viewer)=>new PhoneService(database,'https://example.test').buildRouterValue(db,args,viewer));
  it('builds Needs-you count/cells at the journal cut without starting seen clocks',async()=>{
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('ask',$1,$2,'@reader please approve?')`,[ROOM,OTHER]);
    const before=(await database.query(`SELECT count(*)::int n FROM needs_you_marks`)).rows[0]!.n;
    const result=await snapshot();
    expect(result.family).toBe('needs-you');
    expect(result.value).toMatchObject({count:1,items:[{messageId:'ask'}]});
    expect(result.authority.scopes).toHaveLength(2);
    expect((await database.query(`SELECT count(*)::int n FROM needs_you_marks`)).rows[0]!.n).toBe(before);
    expect(result.cut.through).toBe(Number((await database.query(`SELECT sequence FROM live_streams WHERE id=$1`,[`workspace:${WORKSPACE}`])).rows[0]!.sequence));
  });
  it('keeps committed Tray classification and exact Saved removal under the same final certificate',async()=>{
    const clockVersion=await readyClock();
    const authority=await readRouterCertificate(database,input,VIEWER),atomicGroup=`needs-you:${WORKSPACE}:${VIEWER}`;
    const facts:RouterFact[]=[
      {atomicGroup,authority,payload:{kind:'tray-classification',scope:WORKSPACE,version:1,clockVersion}},
      {atomicGroup,authority,payload:{kind:'tray-needs-replace',scope:WORKSPACE,value:{items:[]}}},
      {atomicGroup,authority,payload:{kind:'saved-row-remove',scope:WORKSPACE,bookmarkId:'33333333-3333-4333-8333-333333333333',messageId:'saved'}}];
    let sent:readonly RouterFact[]=[];
    await fenceRouterBatch(database,WORKSPACE,VIEWER,facts,value=>{sent=value;return undefined;});
    expect(sent).toEqual(facts);
    await database.query(`UPDATE memberships SET removed_at=clock_timestamp() WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,[WORKSPACE,VIEWER]);
    await fenceRouterBatch(database,WORKSPACE,VIEWER,facts,value=>{sent=value;return undefined;});
    expect(sent).toHaveLength(1);expect(sent[0]!.payload).toMatchObject({kind:'authority-fence',mode:'deny'});
  });
  it.each(['owner', 'readiness', 'revision', 'receipt'] as const)('refuses cached Tray facts after %s changes while retaining the independent Room list', async loss => {
    const clockVersion=await readyClock(),authority=await readRouterCertificate(database,input,VIEWER);
    const atomicGroup=`needs-you:${WORKSPACE}:${VIEWER}`;
    const roomList:RouterFact={atomicGroup:`room-list:${WORKSPACE}:${VIEWER}`,authority,
      payload:{kind:'scope-replace',family:'room-list',scope:WORKSPACE,value:{rooms:[]}}};
    const facts:RouterFact[]=[
      {atomicGroup,authority,payload:{kind:'tray-classification',scope:WORKSPACE,version:1,clockVersion}},
      {atomicGroup,authority,payload:{kind:'tray-needs-replace',scope:WORKSPACE,value:{items:[]}}},roomList];
    let sent:readonly RouterFact[]=[];
    await fenceRouterBatch(database,WORKSPACE,VIEWER,facts,value=>{sent=value;return undefined;});
    expect(sent).toEqual(facts);
    if(loss==='owner')await database.query(`UPDATE background_leader_owners SET released_at=clock_timestamp()`);
    if(loss==='readiness')await database.query(`UPDATE tray_clock_state SET ready=false`);
    if(loss==='revision')await database.query(`UPDATE tray_clock_state SET revision=revision+1`);
    if(loss==='receipt')await database.query(`DELETE FROM tray_clock_health`);
    await fenceRouterBatch(database,WORKSPACE,VIEWER,facts,value=>{sent=value;return undefined;});
    expect(sent).toEqual([{atomicGroup,authority,payload:{kind:'group-unavailable',scope:WORKSPACE,reason:'dependency'}},roomList]);
  });
  it('rechecks the committed clock at the socket snapshot reply without a replacement read', async () => {
    await readyClock();
    const args={family:'needs-you-count' as const,workspaceId:WORKSPACE};
    const snapshot=await new PhoneService(database,'https://example.test').readRouterSnapshot(args,VIEWER,{trayClock:true});
    const protocol=routerSocketProtocol(database,VIEWER,()=>{}, {families:['needs-you-count'],listenerReady:()=>true},
      {live:new LiveHub(),phone:new PhoneService(database,'https://example.test'),rooms:()=>[]});
    let enqueued=0;
    try {
      await protocol.handle({type:'router-negotiate',protocol:1,families:['needs-you-count']});
      await protocol.fenceReply('readRouterSnapshot',args,snapshot,()=>{enqueued++;return undefined;});
      expect(enqueued).toBe(1);
      await database.query(`UPDATE tray_clock_state SET revision=revision+1`);
      await expect(protocol.fenceReply('readRouterSnapshot',args,snapshot,()=>{enqueued++;return undefined;}))
        .rejects.toMatchObject({reason:'dependency'});
      const current=await new PhoneService(database,'https://example.test').readRouterSnapshot(args,VIEWER,{trayClock:true});
      await database.query(`UPDATE background_leader_owners SET released_at=clock_timestamp()`);
      await expect(protocol.fenceReply('readRouterSnapshot',args,current,()=>{enqueued++;return undefined;}))
        .rejects.toMatchObject({reason:'dependency'});
      expect(enqueued).toBe(1);
    } finally { protocol.close(); }
  });
  it('forwards shared clock loss as one Tray-only control without a query or socket reset',async()=>{
    await readyClock();await database.query(TRAY_SAVED_WINDOW_SCHEMA);
    const live=clockLive,frames:Record<string,unknown>[]=[],phone=new PhoneService(database,'https://example.test');
    const families=['room-list','needs-you-tray','needs-you-count','needs-you-saved-page'] as const;
    const protocol=routerSocketProtocol(database,VIEWER,raw=>{frames.push(JSON.parse(raw));},
      {families,listenerReady:()=>true,trayClockAvailability:clockAvailability},{live,phone,rooms:()=>[]});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families});frames.length=0;
      const query=vi.spyOn(database,'query'),transaction=vi.spyOn(database,'transaction');
      live.trayClockUnavailable();
      expect(frames).toEqual([{kind:'router-unavailable',stream:'control:tray-clock',
        families:['needs-you-tray','needs-you-count','needs-you-saved-page'],reason:'dependency'}]);
      expect(query).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();
      expect(protocol.supports('room-list')).toBe(true);expect(protocol.supports('needs-you-tray')).toBe(true);
      await database.query('UPDATE background_leader_owners SET released_at=clock_timestamp()');
      clockLive.journalChanged(['jobs:tray-clock-health']);await clockAvailability!.start();
      query.mockClear();transaction.mockClear();
      await expect(protocol.snapshot({family:'needs-you-tray',workspaceId:WORKSPACE})).rejects.toThrow('router_projection_unavailable');
      expect(query).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();
      query.mockRestore();transaction.mockRestore();
    }finally{protocol.close();}
  });
  it('does not advertise the Tray cohort without its installed shared availability consumer',async()=>{
    const frames:Record<string,unknown>[]=[],families=['room-list','needs-you-tray','needs-you-count','needs-you-saved-page'] as const;
    const protocol=routerSocketProtocol(database,VIEWER,raw=>{frames.push(JSON.parse(raw));},{families,listenerReady:()=>true},
      {live:new LiveHub(),phone:new PhoneService(database,'https://example.test'),rooms:()=>[]});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families});
      expect(frames.find(frame=>frame.type==='router-capabilities')).toMatchObject({families:['room-list','needs-you-count']});
    }finally{protocol.close();}
  });
  it('captures public identity dependencies without advancing unrelated Workspaces',async()=>{
    const unrelated='33333333-3333-4333-8333-333333333333';
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Unrelated')`,[unrelated]);
    const head=async(id:string)=>Number((await database.query(`SELECT sequence FROM live_streams WHERE id=$1`,[`workspace:${id}`])).rows[0]!.sequence);
    const before=await head(WORKSPACE),otherBefore=await head(unrelated);
    await database.query(`UPDATE identities SET name='Renamed' WHERE id=$1`,[OTHER]);
    expect(await head(WORKSPACE)).toBeGreaterThan(before);expect(await head(unrelated)).toBe(otherBefore);
    expect((await database.query(`SELECT event->>'sourceTable' source FROM live_journal WHERE stream_id=$1 ORDER BY sequence DESC LIMIT 1`,[`workspace:${WORKSPACE}`])).rows[0]!.source).toBe('identities');
  });
  it('captures old and new Workspace scopes for direct Room moves',async()=>{
    const target='33333333-3333-4333-8333-333333333333';
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Target')`,[target]);
    const head=async(id:string)=>Number((await database.query(`SELECT sequence FROM live_streams WHERE id=$1`,[`workspace:${id}`])).rows[0]!.sequence);
    const previous=await head(WORKSPACE),next=await head(target);
    await database.query(`UPDATE rooms SET workspace_id=$2 WHERE id=$1`,[ROOM,target]);
    expect(await head(WORKSPACE)).toBeGreaterThan(previous);expect(await head(target)).toBeGreaterThan(next);
    const cause=(await database.query(`SELECT event FROM live_journal WHERE stream_id=$1 AND sequence>$2
      AND event->>'sourceTable'='rooms' ORDER BY sequence DESC LIMIT 1`,[`workspace:${WORKSPACE}`,previous])).rows[0]!.event;
    expect(cause).toMatchObject({sourceTable:'rooms',sourceRemoved:true,oldRoomId:ROOM,newRoomId:ROOM});
  });
  it('a membership revoke invalidates an already-built enqueue certificate',async()=>{
    const result=await snapshot(); let enqueued=0;
    await database.query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2 AND room_id IS NULL`,[WORKSPACE,VIEWER]);
    await expect(fenceRouterEnqueue(database,input,VIEWER,result.authority,()=>{enqueued++;return undefined;})).rejects.toThrow('authority');
    expect(enqueued).toBe(0);
  });
  it('name edits preserve authority, while a regrant cannot revive an old certificate',async()=>{
    const initial=await snapshot();
    await database.query(`UPDATE rooms SET name='Changed' WHERE id=$1`,[ROOM]);
    expect((await snapshot()).authority).toEqual(initial.authority);
    await database.query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2 AND room_id IS NULL`,[WORKSPACE,VIEWER]);
    await database.query(`UPDATE memberships SET removed_at=NULL WHERE workspace_id=$1 AND identity_id=$2 AND room_id IS NULL`,[WORKSPACE,VIEWER]);
    const current=await snapshot();
    expect(BigInt(current.authority.scopes[0]!.epoch)).toBeGreaterThan(BigInt(initial.authority.scopes[0]!.epoch));
    await expect(fenceRouterEnqueue(database,input,VIEWER,initial.authority,()=>undefined)).rejects.toThrow('authority');
  });
  it('keeps legacy capability default and refuses snapshot reads without negotiation',async()=>{
    const frames:string[]=[];
    const protocol=routerSocketProtocol(database,VIEWER,frame=>frames.push(frame));
    await protocol.handle({type:'router-negotiate',protocol:1,families:['room-list','needs-you']});
    expect(JSON.parse(frames[0]!)).toEqual({type:'router-capabilities',protocol:1,families:[],commandDedupV1:false,mediaMetadataV1:false,authorityFencesV1:false});
    expect(()=>protocol.requireSnapshot(input)).toThrow('router_family_unavailable');
    protocol.close();
  });
  it('negotiates before delivering same-cut count and tray facts on a healthy session',async()=>{
    const live=new LiveHub(),frames:Record<string,any>[]=[];
    let delivered!:()=>void;const complete=new Promise<void>(resolve=>{delivered=resolve;});
    const protocol=routerSocketProtocol(database,VIEWER,raw=>{const frame=JSON.parse(raw);frames.push(frame);if(frame.kind==='push-commit')delivered();},
      {families:['needs-you','needs-you-count'],listenerReady:()=>true},
      {live,phone:new PhoneService(database,'https://example.test'),rooms:()=>[]});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families:['needs-you','needs-you-count']});
      expect(frames[0]).toMatchObject({type:'router-capabilities',families:['needs-you','needs-you-count']});
      await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('new-ask',$1,$2,'@reader please approve?')`,[ROOM,OTHER]);
      live.journalChanged([`workspace:${WORKSPACE}`]);
      await complete;
      const facts=frames.filter(f=>f.kind==='push-part').flatMap(f=>f.facts);
      const tray=facts.find(f=>f.payload.family==='needs-you'),count=facts.find(f=>f.payload.family==='needs-you-count');
      expect(tray.payload.value).toMatchObject({count:1,items:[{messageId:'new-ask'}]});
      expect(count.payload.value.count).toBe(tray.payload.value.items.length);
      expect(tray.atomicGroup).toBe(count.atomicGroup);expect(tray.authority).toEqual(count.authority);
      expect(frames.filter(f=>f.kind==='push-part').every(f=>f.to.through===frames.at(-1)!.to.through)).toBe(true);
      expect(frames.some(f=>f.type==='invalidate')).toBe(false);
      await database.query('SELECT 1');
    }finally{protocol.close();}
  });
  it('delivers a classified committed Tray interval without rebuilding a Saved window',async()=>{
    await readyClock();await database.query(TRAY_SAVED_WINDOW_SCHEMA);
    const live=clockLive,frames:Record<string,any>[]=[],phone=new PhoneService(database,'https://example.test');
    const build=vi.spyOn(phone,'buildRouterValue');
    let done!:()=>void,fail!:(error:Error)=>void;
    const complete=new Promise<void>((resolve,reject)=>{done=resolve;fail=reject;});
    const families=['needs-you-tray','needs-you-count','needs-you-saved-page'] as const;
    const protocol=routerSocketProtocol(database,VIEWER,raw=>{
      const frame=JSON.parse(raw);frames.push(frame);
      if(frame.kind==='push-commit')done();if(frame.kind==='router-unavailable')fail(new Error(frame.reason));
    },{families,listenerReady:()=>true,trayClockAvailability:clockAvailability},{live,phone,rooms:()=>[]});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families});
      await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('joint-ask',$1,$2,'@reader please approve?')`,[ROOM,OTHER]);
      live.journalChanged([`workspace:${WORKSPACE}`]);await complete;
      const facts=frames.filter(frame=>frame.kind==='push-part').flatMap(frame=>frame.facts);
      expect(facts.filter(fact=>fact.payload.kind==='tray-classification')).toHaveLength(1);
      expect(facts.find(fact=>fact.payload.kind==='tray-needs-replace').payload.value.items).toMatchObject([{messageId:'joint-ask'}]);
      expect(facts.find(fact=>fact.payload.family==='needs-you-count').payload.value).toEqual({count:1});
      expect(new Set(facts.map(fact=>fact.authority.digest)).size).toBe(1);
      expect(build.mock.calls.map(call=>call[1].family)).toEqual(['needs-you-count']);
      expect(facts.some(fact=>fact.payload.kind==='scope-replace'&&fact.payload.family!=='needs-you-count')).toBe(false);
    }finally{protocol.close();}
  });
  it.each([false,true])('reauthorizes populated Tray after an addressed choice, including Saved revocation (%s)',async revokeSaved=>{
    const savedRoom='33333333-3333-4333-8333-333333333333',agent='d'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Helper','helper')`,[agent]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,VIEWER]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`,[WORKSPACE,ROOM,agent]);
    await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Saved Room')`,[savedRoom,WORKSPACE,VIEWER]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[WORKSPACE,savedRoom,VIEWER]);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('retained-save',$1,$2,'Saved private source')`,[savedRoom,OTHER]);
    await database.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at)
      VALUES($1,$2,$3,'retained-save','Saved Room','room',now())`,[VIEWER,WORKSPACE,savedRoom]);
    const choice=await database.transaction(tx=>postRoomChoice(tx,{roomId:ROOM,agentId:agent,mode:'question',prompt:'@reader choose?',
      options:[{label:'One',consequence:'Use one'},{label:'Two',consequence:'Use two'}],ttlSeconds:300}));
    await readyClock();
    const phone=new PhoneService(database,'https://example.test'),live=clockLive;
    const families=['needs-you-tray','needs-you-count','needs-you-saved-page'] as const;
    const request={family:'needs-you-tray' as const,workspaceId:WORKSPACE};
    const lanes=new ReadLanes({origin:'https://example.test',principal:VIEWER,sessionEpoch:1},(args,value)=>validateTrayProjection(value,args.workspaceId!));
    const reads=vi.fn(async(args:any)=>phone.readRouterSnapshot(args,VIEWER,{trayClock:true}));
    lanes.connected(1,families,reads);
    let opened!:()=>void;const opening=new Promise<void>(done=>{opened=done;});
    lanes.subscribe(request,()=>{if(lanes.peek(request).state==='LIVE')opened();});
    lanes.demand(request,{}, {isCurrent:()=>true});await opening;
    expect(lanes.peek(request).value).toMatchObject({needs:{items:[{approval:{actions:expect.arrayContaining([expect.objectContaining({choiceId:choice.choiceId,optionId:'A'})])}}]},saved:{rows:[{value:{messageId:'retained-save',available:true}}]}});
    const frames:any[]=[],accepted:Promise<void>[]=[];
    const assembly=new RouterBatchAssembly(facts=>createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
      batch=>{accepted.push(lanes.accept(batch));},()=>{throw new Error('Invalid wire batch');});
    let committed!:()=>void;const commit=new Promise<void>(done=>{committed=done;});
    const protocol=routerSocketProtocol(database,VIEWER,raw=>{
      const frame=JSON.parse(raw);frames.push(frame);
      if(frame.kind==='push-part'||frame.kind==='push-commit')assembly.accept(frame);
      if(frame.kind==='push-commit')committed();
    },{families,listenerReady:()=>true,trayClockAvailability:clockAvailability},{live,phone,rooms:()=>[]});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families});
      await database.transaction(async tx=>{
        await answerRoomChoice(tx,{choiceId:choice.choiceId,optionId:'A',viewerId:VIEWER},{wake:false});
        if(revokeSaved)await tx.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[savedRoom,VIEWER]);
      });
      live.journalChanged([`workspace:${WORKSPACE}`]);await commit;await Promise.all(accepted);
      for(let i=0;i<20;i++){await database.query('SELECT 1');await new Promise<void>(done=>setImmediate(done));}
      expect(frames.some(frame=>frame.kind==='router-unavailable')).toBe(false);
      expect(lanes.peek(request)).toMatchObject({state:'LIVE',value:{needs:{items:[]}}});
      expect(reads).toHaveBeenCalledTimes(2);
      const serialized=JSON.stringify(lanes.peek(request).value);
      if(revokeSaved)expect(serialized).not.toContain('Saved private source');
      else expect(lanes.peek(request).value).toMatchObject({saved:{rows:[{value:{messageId:'retained-save',available:true,text:'Saved private source'}}]}});
      expect((await database.query(`SELECT count(*)::int n FROM message_bookmarks WHERE message_id='retained-save'`)).rows[0]!.n).toBe(1);
    }finally{protocol.close();}
  });
  it.each([false,true])('shares a new Saved head and isolates head budget failure (%s)',async budgetFailure=>{
    await readyClock();await database.query(TRAY_SAVED_WINDOW_SCHEMA);
    const live=clockLive,phone=new PhoneService(database,'https://example.test');
    const original=phone.buildRouterValue.bind(phone);
    const build=vi.spyOn(phone,'buildRouterValue').mockImplementation(async(db,args,reader,options)=>{
      if(budgetFailure&&args.family==='needs-you-saved-page')throw new Error('saved_window_budget');
      return original(db,args,reader,options);
    });
    const sharedBuilds={coordinator:new RouterBuildCoordinator(),basis:{schema:1 as const,databaseScope:'test',version:'test',
      publicOrigin:'https://example.test',clockVersion:'test'}};
    const families=['room-list','needs-you-tray','needs-you-count','needs-you-saved-page'] as const;
    const frames:Record<string,any>[][]=[[],[]],completions:Promise<void>[]=[];
    const protocols=frames.map(output=>{
      let done!:()=>void,fail!:(error:Error)=>void;
      completions.push(new Promise<void>((resolve,reject)=>{done=resolve;fail=reject;}));
      return routerSocketProtocol(database,VIEWER,raw=>{
        const frame=JSON.parse(raw);output.push(frame);
        if(frame.kind==='push-commit')done();if(frame.kind==='router-unavailable')fail(new Error(frame.reason));
      },{families,listenerReady:()=>true,trayClockAvailability:clockAvailability,sharedBuilds},{live,phone,rooms:()=>[]});
    });
    try{
      for(const protocol of protocols)await protocol.handle({type:'router-negotiate',protocol:1,families});
      await database.transaction(async db=>{
        await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('new-save',$1,$2,'Saved message')`,[ROOM,OTHER]);
        await db.query(`INSERT INTO message_bookmarks(identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,message_created_at)
          VALUES($1,$2,$3,'new-save','Room','room',now())`,[VIEWER,WORKSPACE,ROOM]);
        await db.query(`UPDATE rooms SET name='Changed Room' WHERE id=$1`,[ROOM]);
      });
      live.journalChanged([`workspace:${WORKSPACE}`]);await Promise.all(completions);
      const all=frames.map(output=>output.filter(frame=>frame.kind==='push-part').flatMap(frame=>frame.facts));
      for(const facts of all){
        expect(facts.some(fact=>fact.payload.family==='room-list')).toBe(true);
        if(budgetFailure){
          expect(facts.some(fact=>fact.payload.kind==='group-unavailable'&&fact.atomicGroup===`needs-you:${WORKSPACE}:${VIEWER}`)).toBe(true);
        }else{
          const head=facts.find(fact=>fact.payload.kind==='scope-replace'&&fact.payload.family==='needs-you-saved-page');
          expect(head.payload.value).toMatchObject({rows:[{value:{messageId:'new-save'}}]});
          expect(head.payload.value.before).toBeUndefined();
          expect(facts.filter(fact=>fact.payload.kind==='tray-classification')).toHaveLength(1);
        }
      }
      if(!budgetFailure){
        expect(build.mock.calls.filter(call=>call[1].family==='needs-you-saved-page')).toHaveLength(1);
        expect(all[0]!.find(fact=>fact.payload.family==='needs-you-saved-page')).toEqual(all[1]!.find(fact=>fact.payload.family==='needs-you-saved-page'));
      }
      expect(build.mock.calls.every(call=>!('before' in call[1]))).toBe(true);
    }finally{for(const protocol of protocols)protocol.close();}
  });
  it('parks an unready Tray clock group while delivering the independent Room list',async()=>{
    await database.query(TRAY_CLOCK_SOURCE_SCHEMA);await database.query(TRAY_SAVED_WINDOW_SCHEMA);
    clockAvailability=new TrayClockAvailability(database,clockLive,{listenerReady:()=>true,unavailable:()=>{}});await clockAvailability.start();
    const live=clockLive,frames:Record<string,any>[]=[],phone=new PhoneService(database,'https://example.test');
    const build=vi.spyOn(phone,'buildRouterValue');let done!:()=>void,fail!:(error:Error)=>void;
    const complete=new Promise<void>((resolve,reject)=>{done=resolve;fail=reject;});
    const families=['room-list','needs-you-tray','needs-you-count','needs-you-saved-page'] as const;
    const protocol=routerSocketProtocol(database,VIEWER,raw=>{const frame=JSON.parse(raw);frames.push(frame);
      if(frame.kind==='push-commit')done();if(frame.kind==='router-unavailable')fail(new Error(frame.reason));
    },{families,listenerReady:()=>true,trayClockAvailability:clockAvailability},{live,phone,rooms:()=>[]});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families});
      await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('unready',$1,$2,'@reader please approve?')`,[ROOM,OTHER]);
      live.journalChanged([`workspace:${WORKSPACE}`]);await complete;
      const facts=frames.filter(frame=>frame.kind==='push-part').flatMap(frame=>frame.facts);
      expect(facts.some(fact=>fact.payload.kind==='group-unavailable'&&fact.atomicGroup===`needs-you:${WORKSPACE}:${VIEWER}`)).toBe(true);
      expect(facts.some(fact=>fact.payload.kind==='scope-replace'&&fact.payload.family==='room-list')).toBe(true);
      expect(build.mock.calls.map(call=>call[1].family)).toEqual(['room-list']);
    }finally{protocol.close();}
  });
  it('targets Workspace denial explicitly even when the Room authority epoch did not change',async()=>{
    const live=new LiveHub(),frames:Record<string,any>[]=[];
    const initial=await readRouterCertificate(database,{family:'room-head',workspaceId:WORKSPACE,roomId:ROOM},VIEWER);
    const request={family:'room-head' as const,workspaceId:WORKSPACE,roomId:ROOM};
    const lanes=new ReadLanes({origin:'https://example.test',principal:VIEWER,sessionEpoch:1},()=>true);
    const phone=new PhoneService(database,'https://example.test');let reads=0;
    lanes.connected(1,['room-head'],async()=>{reads++;return buildRouterSnapshot(database,request,VIEWER,(db,args,viewer)=>phone.buildRouterValue(db,args,viewer));});
    let opened!:()=>void,purged!:()=>void;
    const opening=new Promise<void>(resolve=>{opened=resolve;});
    const purge=new Promise<void>(resolve=>{purged=resolve;});
    lanes.subscribe(request,()=>{if(lanes.peek(request).state==='LIVE')opened();if(lanes.peek(request).state==='REVOKED')purged();});
    const assembly=new RouterBatchAssembly(facts=>createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
      batch=>{void lanes.accept(batch);},()=>{throw new Error('Unexpected wire assembly fault');});

    let delivered!:()=>void;const complete=new Promise<void>(resolve=>{delivered=resolve;});
    const protocol=routerSocketProtocol(database,VIEWER,raw=>{const frame=JSON.parse(raw);frames.push(frame);if(frame.kind==='push-part'||frame.kind==='push-commit')assembly.accept(frame);if(frame.kind==='push-commit')delivered();},
      {families:['room-head'],listenerReady:()=>true},
      {live,phone:new PhoneService(database,'https://example.test'),rooms:()=>[ROOM]});
    try{
      await protocol.handle({type:'router-negotiate',protocol:1,families:['room-head']});
      lanes.demand(request,{}, {isCurrent:()=>true});await opening;
      expect(lanes.peek(request).value).not.toBeNull();
      await database.query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2 AND room_id IS NULL`,[WORKSPACE,VIEWER]);
      live.journalChanged([`workspace:${WORKSPACE}`]);await complete;
      const removal=frames.filter(f=>f.kind==='push-part').flatMap(f=>f.facts).find(f=>f.payload.kind==='authority-fence');
      expect(removal.payload).toEqual({kind:'authority-fence',scope:WORKSPACE,authorityScope:`reader:${VIEWER}:workspace:${WORKSPACE}`,mode:'deny'});
      expect(removal.authority.scopes.find((s:any)=>s.authorityScope===`room:${ROOM}`).epoch)
        .toBe(initial.scopes.find(s=>s.authorityScope===`room:${ROOM}`)!.epoch);
      expect(removal.authority.scopes.some((s:any)=>s.authorityScope===removal.payload.authorityScope)).toBe(true);
      await purge;
      expect(lanes.peek(request).value).toBeNull();expect(reads).toBe(1);
      await database.query('SELECT 1');
    }finally{protocol.close();}
  });
  it('drains a coalesced multi-event interval in numeric sequence order across decimal boundaries',async()=>{
    const live=new LiveHub();let delivered!:(value:number[])=>void,failed!:(error:Error)=>void;
    const complete=new Promise<number[]>((resolve,reject)=>{delivered=resolve;failed=reject;});
    const release=await new RouterProjectionDrain(database,live).subscribe(WORKSPACE,async(_db,from,to,causes)=>{
      expect(to.through-from.through).toBe(12);delivered(causes.map(c=>Number(c.ordinal)));
    },reason=>failed(new Error(reason)));
    try{
      await database.query(`SELECT beeline_journal($1,jsonb_build_object('sourceTable','rooms','ordinal',n)) FROM generate_series(1,12)n`,[`workspace:${WORKSPACE}`]);
      live.journalChanged([`workspace:${WORKSPACE}`]);
      expect(await complete).toEqual(Array.from({length:12},(_,i)=>i+1));await database.query('SELECT 1');
    }finally{release();}
  });
  it('drains committed rows independently on two servers and parks on retention loss',async()=>{
    const hubs=[new LiveHub(),new LiveHub()]; const received:number[][]=[[],[]]; const parked:string[]=[];
    const releases=await Promise.all(hubs.map((live,index)=>new RouterProjectionDrain(database,live).subscribe(WORKSPACE,
      async(_db,from,to,causes)=>{expect(causes).toHaveLength(to.through-from.through);received[index]!.push(to.through);},reason=>parked.push(reason))));
    try {
      await database.query(`UPDATE rooms SET name='One change' WHERE id=$1`,[ROOM]);
      for(const live of hubs)live.journalChanged([`workspace:${WORKSPACE}`]);
      await new Promise<void>(resolve=>setImmediate(resolve));
      // A deterministic committed read lets both queued transactional actors run.
      await database.query('SELECT 1');
      await new Promise<void>(resolve=>setImmediate(resolve));
      expect(received[0]).toHaveLength(1);expect(received[1]).toEqual(received[0]);
      await database.query(`SELECT beeline_journal($1,jsonb_build_object('sourceTable','rooms','padding',repeat('x',$2::int)))`,[`workspace:${WORKSPACE}`,LIVE_REPLAY_BYTE_LIMIT+1]);
      for(const live of hubs)live.journalChanged([`workspace:${WORKSPACE}`]);
      await database.query('SELECT 1');await new Promise<void>(resolve=>setImmediate(resolve));
      expect(parked).toEqual(['retention','retention']);
      expect((await database.query(`SELECT coalesce(sum(octet_length(event::text)),0)::text bytes FROM live_journal WHERE stream_id=$1`,[`workspace:${WORKSPACE}`])).rows[0]!.bytes).toBe('0');
    } finally {for(const release of releases)release();}
  });
});

describe('router wire and explicit dependency classifier',()=>{
  it('packs five bounded projections without advancing coverage before final commit',()=>{
    const cut={stream:'workspace:w',epoch:'epoch',through:1,protocol:1 as const};
    const facts=Array.from({length:5},(_,i)=>({atomicGroup:`g${i}`,authority:{digest:'digest',scopes:[{authorityScope:'reader:r:workspace:w',epoch:'1'}]},
      payload:{kind:'scope-replace',family:'needs-you',scope:'w',value:{count:0,items:[],padding:'x'.repeat(60*1024)}}})) as unknown as RouterFact[];
    const frames=encodeRouterBatch(cut,{...cut,through:2},facts);
    expect(frames.filter(f=>f.kind==='push-part')).toHaveLength(5);
    expect(frames.at(-1)!.kind).toBe('push-commit');
    expect(frames.every(f=>Buffer.byteLength(JSON.stringify(f))<=64*1024)).toBe(true);
    expect(new Set(frames.map(f=>f.contentDigest)).size).toBe(1);
  });
  it('classifies only closed committed clock causes for their exact reader and Workspace',()=>{
    const cause={sourceTable:'tray-clock',trayReaderId:VIEWER,trayWorkspaceId:WORKSPACE,kind:'question-age',deadlineId:'a'.repeat(32),incarnation:'b'.repeat(32),revision:'1'};
    expect([...routerSourcePlan([cause],VIEWER,WORKSPACE).families]).toEqual(['needs-you','needs-you-tray','needs-you-count']);
    expect(routerSourcePlan([cause],OTHER,WORKSPACE).families.size).toBe(0);
    for(const invalid of[{...cause,revision:'01'},{...cause,extra:true},{...cause,kind:'choice-close'}])
      expect(()=>routerSourcePlan([invalid],VIEWER,WORKSPACE)).toThrow('dependency');
    expect(()=>routerSourcePlan([cause],VIEWER,ROOM)).toThrow('dependency');
  });
  it('classifies a closed clock-basis transition without inventing changed cells',()=>{
    const cause={sourceTable:'tray-clock-basis',version:1,trayWorkspaceId:WORKSPACE,generation:'a'.repeat(32),revision:'0',ready:true};
    expect(routerSourcePlan([cause],VIEWER,WORKSPACE).families.size).toBe(0);
    expect(routerSourcePlan([{...cause,sourceTable:'tray-clock-readiness',ready:false}],VIEWER,WORKSPACE).families.size).toBe(0);
    for(const invalid of[{...cause,ready:1},{...cause,extra:true},{...cause,revision:'01'}])
      expect(()=>routerSourcePlan([invalid],VIEWER,WORKSPACE)).toThrow('dependency');
    expect(()=>routerSourcePlan([cause],VIEWER,ROOM)).toThrow('dependency');
  });
  it('does not query unrelated families or readers and parks unknown dependencies',()=>{
    expect([...routerSourcePlan([{sourceTable:'room_read_marks',identityId:OTHER,sourceRoomId:ROOM}],VIEWER).families]).toEqual([]);
    expect([...routerSourcePlan([{sourceTable:'agent_commands',sourceRoomId:ROOM}],VIEWER).families]).toEqual(['room-list','room-head']);
    expect(()=>routerSourcePlan([{sourceTable:'new_undeclared_table'}],VIEWER)).toThrow('dependency');
  });
});
