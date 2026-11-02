import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { HelperOverlayFrame } from '@beeline/api-contract/helper-overlay';
import { PostgresDatabase } from './database.js';
import { HELPER_OVERLAY_SCHEMA, HelperOverlayViewer, applyHelperOverlay, fenceHelperOverlayEnqueue, subscribeHelperOverlayDemand } from './helper-overlay.js';
import { LiveHub, type LiveEvent } from './live.js';
import { POSTGRES_LIVE_SCHEMA, PostgresLiveListener } from './postgres-live.js';
const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Overlay proofs require isolated loopback PostgreSQL');
const room='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222';
const frame=(value:Partial<HelperOverlayFrame>={}):HelperOverlayFrame=>({v:1,agentId:'agent',roomId:room,commandId:'command',turnId:'turn',turnGeneration:'generation',runGeneration:0,
  kind:'draft',type:'baseline',revision:1,offset:0,text:'🌍',viewingRevision:1,...value});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};};
describe.skipIf(!url)('overlay real PostgreSQL remote listener and viewer fences',()=>{
  it('relays committed UTF8 generations across pools, replaces a missed revision, and fences zero viewers and terminal resurrection',async()=>{
    const schema='overlay_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:url,options:`-c search_path=${schema},public`,max:3};
    const writer=new PostgresDatabase('',3,{pool:new Pool(config)}),reader=new PostgresDatabase('',3,{pool:new Pool(config)});
    const listenerUrl=new URL(url!);listenerUrl.searchParams.set('options',`-c search_path=${schema},public`);
    const live=new LiveHub(),listener=PostgresLiveListener.forConnectionString(listenerUrl.toString(),reader,live);
    let listening:Promise<void>|undefined,stopDemand:(()=>void)|undefined,stopLive:(()=>void)|undefined;
    const ready=deferred(),stopReady=live.subscribeResync(ready.resolve);
    const frames:LiveEvent[]=[],waits=new Map<number,()=>void>(),demandWaits=new Map<number,()=>void>();
    const waitFrame=(revision:number)=>new Promise<void>(resolve=>{waits.set(revision,resolve);});
    const waitDemand=(revision:number)=>new Promise<void>(resolve=>{demandWaits.set(revision,resolve);});
    const viewer=new HelperOverlayViewer(event=>{void forward(event);});
    const forward=async(event:LiveEvent)=>fenceHelperOverlayEnqueue(reader,event,()=>{
      if(!viewer.canDeliver(event))return;const normalized=viewer.normalize(event);frames.push(normalized);viewer.delivered(normalized);
      const revision=(normalized as {overlayV1?:{revision:number}}).overlayV1?.revision;if(revision)waits.get(revision)?.();
    },'reader');
    try{
      await writer.query(`CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,archived_at timestamptz);
        CREATE TABLE room_access(room_id uuid,identity_id text,removed_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
        CREATE TABLE room_push_views(room_id uuid,identity_id text,session_id text,instance_id text,expires_at timestamptz);
        CREATE TABLE live_server_instances(instance_id text,renewed_at timestamptz);
        CREATE TABLE agent_connections(agent_id text,connection_id text,epoch bigint,released_at timestamptz);
        CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,turn_request_id text,action text,generation_id text,state text,created_at timestamptz DEFAULT now());
        CREATE TABLE agent_turns(room_id uuid,agent_id text,request_id text,generation_id text,status text);
        CREATE TABLE live_outputs(room_id uuid,agent_id text,turn_id text,kind text,body jsonb,updated_at timestamptz DEFAULT now(),PRIMARY KEY(room_id,agent_id,turn_id,kind));
        CREATE TABLE registry_mcp_oauth_attempts(state text,connector_id text,expires_at timestamptz,code text);`);
      // Install the production journal+capture function, and its real source
      // trigger on the one table this isolated fixture exercises.
      await writer.query(POSTGRES_LIVE_SCHEMA.split('-- Memory jobs')[0]!);
      await writer.query(`CREATE TRIGGER beeline_notify_live_live_outputs AFTER INSERT OR UPDATE OR DELETE ON live_outputs FOR EACH ROW EXECUTE FUNCTION beeline_notify_live()`);
      await writer.query(HELPER_OVERLAY_SCHEMA);
      await writer.query(`INSERT INTO rooms VALUES($1,$2,NULL)`,[room,workspace]);
      await writer.query(`INSERT INTO room_access VALUES($1,'agent',NULL),($1,'reader',NULL)`,[room]);
      await writer.query(`INSERT INTO memberships VALUES($1,NULL,'agent','member',NULL),($1,NULL,'reader','member',NULL)`,[workspace]);
      await writer.query(`INSERT INTO room_push_views VALUES($1,'reader','phone-on-reader-instance',NULL,NULL)`,[room]);
      await writer.query(`INSERT INTO agent_connections VALUES('agent','connection',1,NULL);
        INSERT INTO agent_turns VALUES('${room}','agent','turn','generation','working');
        INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,generation_id,state) VALUES('command','${room}','agent','turn','input','generation','claimed');`);
      listening=listener.run();await ready.promise;
      stopLive=live.subscribe(room,event=>{if(viewer.accept(event))void forward(event);});viewer.enter(room);viewer.commit(room,1);
      const demand1=waitDemand(1);stopDemand=subscribeHelperOverlayDemand(reader,room,demand=>{demandWaits.get(demand.viewingRevision)?.();});await demand1;
      const owner={connectionId:'connection',epoch:1};
      const first=waitFrame(1);expect((await applyHelperOverlay(writer,'agent',owner,frame())).ack).toEqual({accepted:true,revision:1});await first;
      const second=waitFrame(2);await applyHelperOverlay(writer,'agent',owner,frame({type:'append',revision:2,offset:4,text:'é'}));await second;
      expect(frames.at(-1)).toMatchObject({text:'🌍é',overlayV1:{type:'append',offset:4,revision:2}});
      const fourth=waitFrame(4);
      await writer.transaction(async tx=>{
        await applyHelperOverlay(tx,'agent',owner,frame({type:'append',revision:3,offset:6,text:'!'}));
        await applyHelperOverlay(tx,'agent',owner,frame({type:'append',revision:4,offset:7,text:'?'}));
      });await fourth;
      expect(frames.at(-1)).toMatchObject({text:'🌍é!?',overlayV1:{type:'replace',offset:0,revision:4}});
      expect((await writer.query('SELECT count(*)::integer count FROM live_journal')).rows).toEqual([{count:0}]);
      const off=waitDemand(2);await writer.query('DELETE FROM room_push_views');await off;viewer.leave(room);
      expect((await applyHelperOverlay(writer,'agent',owner,frame({type:'append',revision:5,offset:8,text:'hidden'}))).ack).toEqual({accepted:false,reason:'unviewed'});
      const on=waitDemand(3);await writer.query(`INSERT INTO room_push_views VALUES($1,'reader','new-view',NULL,NULL)`,[room]);await on;
      viewer.enter(room);viewer.commit(room,3);
      const baseline=waitFrame(5);await applyHelperOverlay(writer,'agent',owner,frame({revision:5,runGeneration:1,text:'fresh run',viewingRevision:3}));await baseline;
      const ended=waitFrame(6);await applyHelperOverlay(writer,'agent',owner,frame({type:'end',revision:6,runGeneration:1,text:'',viewingRevision:3}));await ended;
      expect(frames.at(-1)).toMatchObject({type:'retract',overlayV1:{revision:6,runGeneration:1}});
      expect((await applyHelperOverlay(writer,'agent',owner,frame({revision:7,runGeneration:0,text:'late baseline',viewingRevision:3}))).ack).toEqual({accepted:false,reason:'stale'});
      await writer.query(`UPDATE agent_commands SET state='complete';UPDATE agent_turns SET status='complete'`);
      const before=frames.length;await forward(frames[0]!);expect(frames).toHaveLength(before);
    }finally{
      stopReady();stopDemand?.();stopLive?.();await listener.stop();await listening;
      await Promise.all([writer.close(),reader.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    }
  },20000);
});
