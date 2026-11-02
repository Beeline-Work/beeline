import { createHash } from 'node:crypto';
import { ReadLanes } from '../../../packages/net/src/private/read-lanes.js';
import { RouterBatchAssembly } from '../../../packages/net/src/private/batch-assembly.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RouterFact } from '@beeline/api-contract/router-protocol';
import { LIVE_REPLAY_BYTE_LIMIT } from './durable-live.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { buildRouterSnapshot, encodeRouterBatch, fenceRouterEnqueue, readRouterCertificate, RouterProjectionDrain } from './router-projections.js';
import { routerSocketProtocol } from './router-socket.js';
import { routerSourcePlan } from './router-source-plan.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const VIEWER='a'.repeat(64), OTHER='b'.repeat(64);
const WORKSPACE='11111111-1111-4111-8111-111111111111';
const ROOM='22222222-2222-4222-8222-222222222222';
const input={family:'needs-you' as const,workspaceId:WORKSPACE};
describe('router projections: pure coherent cuts and bounded delivery',()=>{
  let database:PgliteDatabase;
  beforeEach(async()=>{
    database=await migratedDatabase();
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'human','Other','other')`,[VIEWER,OTHER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,[ROOM,WORKSPACE,VIEWER]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$4,'member')`,[WORKSPACE,ROOM,VIEWER,OTHER]);
  });
  afterEach(async()=>{await database.close();});
  const snapshot=()=>buildRouterSnapshot(database,input,VIEWER,(db,args,viewer)=>new PhoneService(database,'https://example.test').buildRouterValue(db,args,viewer));
  it('builds Needs-you count/cells at the journal cut without starting seen clocks',async()=>{
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('ask',$1,$2,'@reader please approve?')`,[ROOM,OTHER]);
    const before=(await database.query(`SELECT count(*)::int n FROM needs_you_marks`)).rows[0]!.n;
    const result=await snapshot();
    expect(result.family).toBe('needs-you');
    expect(result.value).toMatchObject({count:1,items:[{messageId:'ask'}]});
    expect(result.authority.scopes).toHaveLength(1);
    expect((await database.query(`SELECT count(*)::int n FROM needs_you_marks`)).rows[0]!.n).toBe(before);
    expect(result.cut.through).toBe(Number((await database.query(`SELECT sequence FROM live_streams WHERE id=$1`,[`workspace:${WORKSPACE}`])).rows[0]!.sequence));
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
    const cause=(await database.query(`SELECT event FROM live_journal WHERE stream_id=$1 ORDER BY sequence DESC LIMIT 1`,[`workspace:${WORKSPACE}`])).rows[0]!.event;
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
      const removal=frames.filter(f=>f.kind==='push-part').flatMap(f=>f.facts).find(f=>f.payload.kind==='authority');
      expect(removal.payload).toEqual({kind:'authority',scope:WORKSPACE,authorityScope:`reader:${VIEWER}:workspace:${WORKSPACE}`,allowed:false});
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
  it('does not query unrelated families or readers and parks unknown dependencies',()=>{
    expect([...routerSourcePlan([{sourceTable:'room_read_marks',identityId:OTHER,sourceRoomId:ROOM}],VIEWER).families]).toEqual([]);
    expect([...routerSourcePlan([{sourceTable:'agent_commands',sourceRoomId:ROOM}],VIEWER).families]).toEqual(['room-list','room-head']);
    expect(()=>routerSourcePlan([{sourceTable:'new_undeclared_table'}],VIEWER)).toThrow('dependency');
  });
});
