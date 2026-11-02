import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import type {RouterFact,RouterSnapshot,RouterAuthorityFence,ScheduledWorkAuthorityFrame} from '@beeline/api-contract/router-protocol';
import {PostgresDatabase,type SqlDatabase} from './database.js';
import {DURABLE_LIVE_SCHEMA} from './durable-live.js';
import {ROUTER_PROJECTION_SCHEMA} from './router-projection-schema.js';
import {SCHEDULED_WORK_AUTHORITY_SCHEMA,scheduledMemberDomain} from './scheduled-work-authority.js';
import {ScheduledWorkAuthorityDelivery} from './scheduled-work-authority-delivery.js';
import {buildRouterSnapshot} from './router-projections.js';
import {LiveHub} from './live.js';
const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Scheduled Work coverage proof requires isolated loopback PostgreSQL');
const WS='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222',DM='33333333-3333-4333-8333-333333333333',VIEWER='a'.repeat(64);
const input=(roomId=ROOM)=>({family:'room-scheduled-work' as const,roomId,workspaceId:WS});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
describe.skipIf(!url)('real PostgreSQL complete authority barrier through data enqueue',()=>{
  it('holds one final shared lock across current controls/barrier/A enqueue, rejects B, and preserves a later currently-allowed regrant floor',async()=>{
    const schema=`scheduled_coverage_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
    const db=new PostgresDatabase('',2,{pool:new Pool(config)}),writer=new PostgresDatabase('',2,{pool:new Pool(config)});
    const reached=deferred(),release=deferred();let owner:ScheduledWorkAuthorityDelivery|undefined;
    try{
      await db.query(`CREATE TABLE identities(id text PRIMARY KEY,kind text NOT NULL,hidden_from_roster boolean NOT NULL DEFAULT false);
        CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,parent_id uuid,archived_at timestamptz,direct_participants jsonb);
        CREATE TABLE memberships(workspace_id uuid NOT NULL,room_id uuid,identity_id text NOT NULL,role text NOT NULL,removed_at timestamptz);`);
      await db.query(DURABLE_LIVE_SCHEMA);await db.query(ROUTER_PROJECTION_SCHEMA);await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);
      await db.query(`INSERT INTO identities(id,kind) VALUES($1,'human')`,[VIEWER]);await db.query(`INSERT INTO workspaces VALUES($1)`,[WS]);
      await db.query(`INSERT INTO rooms(id,workspace_id,direct_participants) VALUES($1,$3,NULL),($2,$3,$4::jsonb)`,[ROOM,DM,WS,JSON.stringify([VIEWER])]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`,[WS,DM,VIEWER]);
      const snapshot=async(roomId:string)=>await buildRouterSnapshot(db,input(roomId),VIEWER,async()=>({roomName:'Synthetic',agentNames:[],schedules:[],subscriptions:[]})) as RouterSnapshot<'room-scheduled-work'>;
      const a=await snapshot(ROOM),b=await snapshot(DM);
      const fact=(value:typeof a):RouterFact=>({atomicGroup:value.atomicGroup,authority:value.authority,payload:{kind:'scope-replace',family:value.family,scope:value.scope,value:value.value}});
      const observed:SqlDatabase={query:(sql,args)=>db.query(sql,args),transaction:work=>db.transaction(tx=>work({
        transaction:nested=>tx.transaction(nested),query:async(sql,args)=>{const result=await tx.query(sql,args);
          if(sql.includes('pg_advisory_xact_lock_shared')){reached.resolve();await release.promise;}return result;},
      }))};
      const frames:(RouterAuthorityFence|ScheduledWorkAuthorityFrame)[]=[],events:string[]=[],unavailable:string[]=[];
      owner=await ScheduledWorkAuthorityDelivery.open(observed,new LiveHub(),VIEWER,frame=>{frames.push(frame);events.push(frame.kind);return undefined;},reason=>unavailable.push(reason));
      await writer.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[DM,VIEWER]);
      let safe:readonly RouterFact[]=[];
      const sending=owner.fenceBatch(WS,[fact(a),fact(b)],owner.start.segment,(facts,barrier)=>{
        safe=facts;const commit=frames.filter(frame=>frame.kind==='scheduled-work-authority-commit').at(-1)!;
        expect('to'in commit&&barrier).toEqual('to'in commit?commit.to:null);events.push('data-enqueue');return undefined;
      });await reached.promise;
      await expect(writer.transaction(async tx=>{await tx.query("SET LOCAL lock_timeout='100ms'");
        await tx.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`,[DM,VIEWER]);
      })).rejects.toMatchObject({code:'55P03'});
      expect(events).toEqual([]);release.resolve();await sending;
      expect(events.at(-2)).toBe('scheduled-work-authority-commit');expect(events.at(-1)).toBe('data-enqueue');
      expect(safe.filter(item=>item.payload.kind==='scope-replace').map(item=>item.atomicGroup)).toEqual([a.atomicGroup]);
      expect(safe).toContainEqual(expect.objectContaining({atomicGroup:b.atomicGroup,payload:expect.objectContaining({mode:'deny',authorityScope:scheduledMemberDomain(VIEWER,DM)})}));
      // No notification is needed for this assertion: the next actual enqueue
      // reads the current control source while holding its own final lock.
      await writer.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`,[DM,VIEWER]);frames.length=0;
      await owner.fenceBatch(WS,[fact(b)],owner.start.segment,facts=>{safe=facts;return undefined;});
      const floor=frames.flatMap(frame=>'fences'in frame?frame.fences:[]).find(frame=>frame.authorityScope===scheduledMemberDomain(VIEWER,DM));
      expect(floor?.mode).toBe('advance');expect(safe.some(item=>item.payload.kind==='scope-replace')).toBe(false);
      let aSent=0;await owner.fenceSnapshot(input(),a,owner.start.segment,()=>{aSent++;return undefined;});expect(aSent).toBe(1);expect(unavailable).toEqual([]);
    }finally{release.resolve();owner?.close();await Promise.all([db.close(),writer.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
  });
});
