import {createHash} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {ReadLanes,type LaneBatch} from '../../../packages/net/src/private/read-lanes.js';
import {RouterBatchAssembly} from '../../../packages/net/src/private/batch-assembly.js';
import type {RouterSnapshotInput} from '@beeline/api-contract/router-protocol';
import type {SqlDatabase} from './database.js';
import {LiveHub} from './live.js';
import {PhoneService} from './phone-service.js';
import {readRouterRoomAudience} from './router-room-audience.js';
import {routerSourcePlan} from './router-source-plan.js';
import {routerSocketProtocol} from './router-socket.js';
import {buildRouterSnapshot,readRouterAuthority} from './router-projections.js';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
const VIEWER='a'.repeat(64),PEER='b'.repeat(64);
const WS='11111111-1111-4111-8111-111111111111',A='22222222-2222-4222-8222-222222222222',B='33333333-3333-4333-8333-333333333333';
const P='44444444-4444-4444-8444-444444444444',PRIVATE='55555555-5555-4555-8555-555555555555';
const room=(roomId:string,workspaceId=WS)=>({family:'room-head' as const,roomId,workspaceId});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const settle=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
describe('DB-derived Room audience and snapshot subscription barrier',()=>{
  let db:PgliteDatabase,phone:PhoneService;
  beforeEach(async()=>{
    db=await migratedDatabase();phone=new PhoneService(db,'https://synthetic.test');
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'human','Peer','peer')`,[VIEWER,PEER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WS]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$3,$4,'A'),($2,$3,$4,'B')`,[A,B,WS,PEER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$4,'member'),($1,$2,$4,'member'),($1,$3,$4,'member')`,[WS,A,B,VIEWER]);
  });
  afterEach(async()=>{await db.close();});
  function connect(database:SqlDatabase=db){
    const live=new LiveHub(),frames:Record<string,any>[]=[],batches:LaneBatch[]=[];
    let applied=Promise.resolve(),onCommit:(()=>void)|undefined,transportReads=0;
    const lanes=new ReadLanes({origin:'https://synthetic.test',principal:VIEWER,sessionEpoch:1},()=>true);
    const assembly=new RouterBatchAssembly(hash,batch=>{batches.push(batch);applied=lanes.accept(batch);},()=>{throw new Error('Unexpected batch fault');});
    const protocol=routerSocketProtocol(database,VIEWER,raw=>{
      const frame=JSON.parse(raw);frames.push(frame);
      if(frame.kind==='push-part'||frame.kind==='push-commit')assembly.accept(frame);
      if(frame.kind==='push-commit')onCommit?.();
    },{families:['room-head'],listenerReady:()=>true,roomHeadContinuityV1:true},
    {live,phone,rooms:()=>{transportReads++;return [];}});
    const negotiate=async()=>{
      await protocol.handle({type:'router-negotiate',protocol:1,families:['room-head'],roomHeadContinuityV1:true,authorityFencesV1:true});
      lanes.connected(1,['room-head'],async input=>{
        const value=await protocol.snapshot(input);await protocol.fenceReply('readRouterSnapshot',{...input},value,()=>undefined);return value;
      },{roomHeadContinuityV1:true});
    };
    const change=async(work:()=>Promise<unknown>,streams=[`workspace:${WS}`])=>{
      const complete=deferred();onCommit=complete.resolve;await work();live.journalChanged(streams);
      await complete.promise;await applied;return batches.at(-1)!;
    };
    const demand=async(input=room(A))=>{
      const installed=deferred();const stop=lanes.subscribe(input,()=>{if(lanes.peek(input).state==='LIVE')installed.resolve();});
      const release=lanes.demand(input,{}, {isCurrent:()=>true});await installed.promise;stop();return release;
    };
    return {live,frames,batches,lanes,protocol,negotiate,change,demand,transportReads:()=>transportReads,applied:()=>applied};
  }
  it('keeps an inactive A current through B traffic and a later A edit, with no legacy transport Room inventory or new read',async()=>{
    const c=connect(),builds:string[]=[];const build=phone.buildRouterValue.bind(phone);
    phone.buildRouterValue=async(tx,input,viewer)=>{builds.push(input.roomId??'');return build(tx,input,viewer);};
    try{
      await c.negotiate();expect(c.frames[0]).toMatchObject({type:'router-capabilities',roomHeadContinuityV1:true});
      const audience=await readRouterRoomAudience(db,WS,VIEWER,routerSourcePlan([],VIEWER));
      expect(audience.find(value=>value.roomId===A)!.authority).toEqual(await readRouterAuthority(db,room(A),VIEWER));
      expect(Object.keys(audience.find(value=>value.roomId===A)!.authority.scopes[0]!)).toEqual(['authorityScope','epoch']);
      const release=await c.demand();release();expect(c.lanes.peek(room(A)).state).toBe('INACTIVE_CACHED');
      const before=builds.length;
      await c.change(()=>db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('B-traffic',$1,$2,'B changed')`,[B,PEER]));
      expect(builds.slice(before)).toEqual([B]);
      expect(c.lanes.peek(room(A)).state).toBe('INACTIVE_CACHED');
      await c.change(()=>db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('A-edit',$1,$2,'A changed while inactive')`,[A,PEER]));
      const held=c.lanes.peek(room(A));expect(held.state).toBe('INACTIVE_CACHED');expect(JSON.stringify(held.value)).toContain('A changed while inactive');
      const reads=builds.length;c.lanes.demand(room(A),{}, {isCurrent:()=>true});await settle();
      expect(c.lanes.peek(room(A)).state).toBe('LIVE');expect(builds).toHaveLength(reads);expect(c.transportReads()).toBe(0);
    }finally{c.protocol.close();}
  });
  it('buffers a complete push while its older already-built snapshot reply is delayed, then installs the current head without another read',async()=>{
    const built=deferred(),release=deferred();const original=phone.readRouterSnapshot.bind(phone);let reads=0;
    phone.readRouterSnapshot=async input=>{reads++;const value=await original(input,VIEWER);built.resolve();await release.promise;return value;};
    const c=connect();try{
      await c.negotiate();const installed=c.demand();await built.promise;
      await c.change(()=>db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('during-snapshot',$1,$2,'Committed after baseline')`,[A,PEER]));
      expect(c.lanes.peek(room(A)).value).toBeNull();release.resolve();await installed;await settle();
      expect(JSON.stringify(c.lanes.peek(room(A)).value)).toContain('Committed after baseline');
      expect(c.lanes.peek(room(A)).cut?.through).toBe(c.batches[0]!.to.through);expect(reads).toBe(1);
    }finally{release.resolve();c.protocol.close();}
  });
  it('subscribe-before-head retains an actual wake arriving after the initial head read but before its result is delivered',async()=>{
    let armed=true,c:ReturnType<typeof connect>;
    const observed:SqlDatabase={transaction:work=>db.transaction(work),query:async(sql,args)=>{
      const value=await db.query(sql,args);
      if(armed&&sql.includes('SELECT epoch,sequence::text')&&args?.[0]===`workspace:${WS}`){
        armed=false;await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('initial-race',$1,$2,'During initial subscription')`,[A,PEER]);
        c.live.journalChanged([`workspace:${WS}`]);
      }
      return value;
    }};
    c=connect(observed);try{
      await c.negotiate();
      // The pending drain is ordered behind the capability acknowledgement.
      const delivered=deferred();const stop=c.lanes.subscribe(room(A),()=>{if(c.lanes.peek(room(A)).state==='LIVE')delivered.resolve();});
      const release=c.lanes.demand(room(A),{}, {isCurrent:()=>true});await delivered.promise;stop();
      expect(c.frames[0]!.type).toBe('router-capabilities');expect(armed).toBe(false);
      expect(JSON.stringify(c.lanes.peek(room(A)).value)).toContain('During initial subscription');release();
    }finally{c.protocol.close();}
  });
  it('adds a newly granted Workspace from DB authority before its first snapshot and receives its next committed edit',async()=>{
    const second='66666666-6666-4666-8666-666666666666',r='77777777-7777-4777-8777-777777777777';
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Later workspace')`,[second]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Later Room')`,[r,second,PEER]);
    const c=connect();try{
      await c.negotiate();await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`,[second,r,VIEWER]);
      const input=room(r,second);await c.demand(input);
      await c.change(()=>db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('later-edit',$1,$2,'Later Workspace push')`,[r,PEER]),[`workspace:${second}`]);
      expect(c.batches.at(-1)!.to.stream).toBe(`workspace:${second}`);expect(JSON.stringify(c.lanes.peek(input).value)).toContain('Later Workspace push');
    }finally{c.protocol.close();}
  });
  it('pins the server-resolved Workspace so a roomId-only move cannot bypass the checked subscription barrier',async()=>{
    const second='66666666-6666-4666-8666-666666666666';
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Move target')`,[second]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,[second,VIEWER]);
    let armed=false,moves=0,builds=0;
    const observed:SqlDatabase={transaction:work=>db.transaction(work),query:async(sql,args)=>{
      const value=await db.query(sql,args);
      if(armed&&sql.includes('SELECT workspace_id FROM rooms WHERE id=$1')){
        armed=false;moves++;await db.query(`UPDATE rooms SET workspace_id=$1 WHERE id=$2`,[second,A]);
      }
      return value;
    }};
    phone.readRouterSnapshot=(input,viewer)=>buildRouterSnapshot(db,input,viewer,async()=>{builds++;return {count:0};});
    const c=connect(observed);try{
      await c.negotiate();armed=true;
      await expect(c.protocol.snapshot({family:'room-head',roomId:A})).rejects.toMatchObject({reason:'authority'});
      expect(moves).toBe(1);expect(builds).toBe(0);
    }finally{c.protocol.close();}
  });
  it('uses old parent source authority for a reparent but never includes an unrelated private Room',async()=>{
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$3,$4,'Parent'),($2,$3,$4,'Private')`,[P,PRIVATE,WS,PEER]);
    await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`,[A,B]);
    // The child inherits A; remove its obsolete direct row so the former
    // audience genuinely depends on the captured old parent relationship.
    await db.query(`DELETE FROM memberships WHERE room_id=$1 AND identity_id=$2`,[B,VIEWER]);
    const before=Number((await db.query(`SELECT sequence FROM live_streams WHERE id=$1`,[`workspace:${WS}`])).rows[0]!.sequence);
    await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`,[P,B]);
    const causes=(await db.query<{event:Record<string,unknown>}>(`SELECT event FROM live_journal WHERE stream_id=$1 AND sequence>$2 ORDER BY sequence`,[`workspace:${WS}`,before])).rows.map(row=>row.event);
    expect(causes.some(cause=>cause.oldParentRoomId===A&&cause.newParentRoomId===P)).toBe(true);
    const audience=await readRouterRoomAudience(db,WS,VIEWER,routerSourcePlan(causes,VIEWER));
    expect(audience.find(row=>row.roomId===B)).toMatchObject({denied:{scope:P,authorityScope:`room:${P}`},changed:true});
    const privateCause=routerSourcePlan([{sourceTable:'messages',sourceRoomId:PRIVATE}],VIEWER);
    expect((await readRouterRoomAudience(db,WS,VIEWER,privateCause)).some(row=>row.roomId===PRIVATE)).toBe(false);
  });
  it('coalesces a thousand committed authority wakes during one refresh and does not turn query failure into another attempt',async()=>{
    const began=deferred(),release=deferred(),followed=deferred(),failed=deferred();
    let reads=0,block=false,fail=false;
    const observed:SqlDatabase={transaction:work=>db.transaction(work),query:async(sql,args)=>{
      if(sql.includes('SELECT workspace_id FROM memberships')&&sql.includes('ORDER BY workspace_id')){
        reads++;
        if(block){block=false;began.resolve();await release.promise;}
        if(fail){fail=false;failed.resolve();throw new Error('Synthetic membership query failure');}
        const value=await db.query(sql,args);if(reads===3)followed.resolve();return value;
      }
      return db.query(sql,args);
    }};
    const c=connect(observed);try{
      await c.negotiate();expect(reads).toBe(1);block=true;
      c.live.journalChanged([`authority:${VIEWER}`]);await began.promise;
      for(let i=0;i<1000;i++)c.live.journalChanged([`authority:${VIEWER}`]);
      expect(reads).toBe(2);release.resolve();await followed.promise;await settle();expect(reads).toBe(3);
      fail=true;c.live.journalChanged([`authority:${VIEWER}`]);await failed.promise;await settle();
      expect(reads).toBe(4);await db.query('SELECT 1');await settle();expect(reads).toBe(4);
    }finally{release.resolve();c.protocol.close();}
  });
  it('replaces failed Workspace cleanup owners instead of retaining one per lifetime rejoin',async()=>{
    const live=new LiveHub(),unsubscribed:number[]=[];const subscribe=live.subscribeJournal.bind(live);
    live.subscribeJournal=listener=>{
      const index=unsubscribed.push(0)-1,release=subscribe(listener);
      return ()=>{unsubscribed[index]++;release();};
    };
    let ready:(()=>void)|undefined,builds=0;
    const observed:SqlDatabase={transaction:work=>db.transaction(work),query:async(sql,args)=>{
      const value=await db.query(sql,args);if(sql.includes('SELECT epoch,sequence::text')&&args?.[0]===`workspace:${WS}`)ready?.();return value;
    }};
    const original=phone.buildRouterValue.bind(phone);phone.buildRouterValue=async(...args)=>{builds++;return original(...args);};
    const protocol=routerSocketProtocol(observed,VIEWER,()=>{}, {families:['room-head'],listenerReady:()=>true}, {live,phone,rooms:()=>[]});
    try{
      // No independent authority subscription here: this proof counts only
      // the DB-audience refresh actor and its Workspace delivery owners.
      await protocol.handle({type:'router-negotiate',protocol:1,families:['room-head']});
      for(let i=0;i<12;i++){
        live.projectionUnavailable();const joined=deferred();ready=joined.resolve;
        await db.query(`UPDATE memberships SET role=$1 WHERE workspace_id=$2 AND room_id IS NULL AND identity_id=$3`,[i%2?'member':'owner',WS,VIEWER]);
        live.journalChanged([`authority:${VIEWER}`]);await joined.promise;await settle();
      }
      expect(builds).toBe(0);expect(unsubscribed).toHaveLength(14);
      protocol.close();expect(unsubscribed.every(count=>count===1)).toBe(true);
    }finally{protocol.close();}
  });
  for(const size of [16,128])it(`records ${size}-Room unrelated-source fanout with one audience query and zero DTO builders`,async()=>{
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) SELECT ('88888888-8888-4888-8888-'||lpad(n::text,12,'0'))::uuid,$1,$2,'Measured'||n FROM generate_series(1,$3::int)n`,[WS,PEER,size-2]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT $1,id,$2,'member' FROM rooms WHERE workspace_id=$1 AND id NOT IN($3,$4)`,[WS,VIEWER,A,B]);
    let queries=0,audienceQueries=0,builders=0;const observed:SqlDatabase={transaction:work=>db.transaction(tx=>work(wrap(tx))),query:(sql,args)=>db.query(sql,args)};
    const wrap=(tx:SqlDatabase):SqlDatabase=>({transaction:work=>tx.transaction(nested=>work(wrap(nested))),query:async(sql,args)=>{
      queries++;if(sql.includes('WITH prior AS'))audienceQueries++;return tx.query(sql,args);
    }});
    const original=phone.buildRouterValue.bind(phone);phone.buildRouterValue=async(...args)=>{builders++;return original(...args);};
    const c=connect(observed);try{
      await c.negotiate();queries=0;
      const batch=await c.change(()=>db.query(`UPDATE workspaces SET name='Unrelated header change' WHERE id=$1`,[WS]));
      expect(batch.facts).toHaveLength(size);expect(batch.facts.every(fact=>fact.payload.kind==='authority-fence')).toBe(true);
      expect(builders).toBe(0);expect(audienceQueries).toBe(1);expect(c.transportReads()).toBe(0);
      console.log('ROOM_AUDIENCE_WORKLOAD',JSON.stringify({cohort:'local PGlite; synthetic authorized Rooms',audience:size,
        statements:queries,audienceQueries,builders,wireBytes:Buffer.byteLength(JSON.stringify(c.frames.slice(1))),facts:batch.facts.length,
        limits:'Metadata fanout is linear in DB audience. No real PostgreSQL CPU/WAL or native parse/render claim; no latency comparison.'}));
    }finally{c.protocol.close();}
  });
  it('installs snapshots and a complete push for 129 authorized Rooms beyond the former audience cap',async()=>{
    const size=129,last='99999999-9999-4999-8999-000000000127';
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) SELECT ('99999999-9999-4999-8999-'||lpad(n::text,12,'0'))::uuid,$1,$2,'Room'||n FROM generate_series(1,$3::int)n`,[WS,PEER,size-2]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) SELECT $1,id,$2,'member' FROM rooms WHERE workspace_id=$1 AND id NOT IN($3,$4)`,[WS,VIEWER,A,B]);
    let reads=0;const original=phone.readRouterSnapshot.bind(phone);phone.readRouterSnapshot=async(...args)=>{reads++;return original(...args);};
    const c=connect();try{
      await c.negotiate();
      expect(await readRouterRoomAudience(db,WS,VIEWER,routerSourcePlan([],VIEWER))).toHaveLength(size);
      const releaseA=await c.demand(),releaseLast=await c.demand(room(last));
      expect(reads).toBe(2);expect(c.lanes.peek(room(last)).state).toBe('LIVE');
      const heldA=c.lanes.peek(room(A)).value;
      const batch=await c.change(()=>db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('beyond-old-cap',$1,$2,'Room 129 committed edit')`,[last,PEER]));
      expect(batch.facts).toHaveLength(size);
      expect(JSON.stringify(c.lanes.peek(room(last)).value)).toContain('Room 129 committed edit');
      expect(c.lanes.peek(room(last)).state).toBe('LIVE');
      expect(c.lanes.peek(room(A)).state).toBe('LIVE');expect(c.lanes.peek(room(A)).value).toEqual(heldA);
      expect(c.lanes.peek(room(last)).cut?.through).toBe(batch.to.through);
      expect(c.frames.some(frame=>frame.kind==='router-unavailable')).toBe(false);
      expect(reads).toBe(2);expect(c.transportReads()).toBe(0);releaseA();releaseLast();
    }finally{c.protocol.close();}
  });
});
