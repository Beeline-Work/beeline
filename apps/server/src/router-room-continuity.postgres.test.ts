import {randomUUID,createHash} from 'node:crypto';
import {Client,Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import type {RouterValues} from '@beeline/api-contract/router-protocol';
import {ReadLanes} from '../../../packages/net/src/private/read-lanes.js';
import {RouterBatchAssembly} from '../../../packages/net/src/private/batch-assembly.js';
import {PostgresDatabase} from './database.js';
import {DURABLE_LIVE_SCHEMA} from './durable-live.js';
import {ROUTER_PROJECTION_SCHEMA} from './router-projection-schema.js';
import {buildRouterSnapshot} from './router-projections.js';
import {LiveHub} from './live.js';
import {PhoneService} from './phone-service.js';
import {routerSocketProtocol} from './router-socket.js';
const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('Room continuity proof requires isolated loopback PostgreSQL');
const WS='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222',VIEWER='synthetic-reader';
const input={family:'room-head' as const,workspaceId:WS,roomId:ROOM};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
describe.skipIf(!url)('real PostgreSQL Room baseline/listener ordering',()=>{
  it('keeps a committed LISTEN-delivered replacement across an older delayed snapshot reply without another read',async()=>{
    const schema=`room_feed_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options={connectionString:url,options:`-c search_path=${schema},public`,max:2};
    const db=new PostgresDatabase('',2,{pool:new Pool(options)}),writer=new PostgresDatabase('',2,{pool:new Pool(options)});
    const listener=new Client(options),built=deferred(),release=deferred(),delivered=deferred(),installed=deferred();
    let protocol:ReturnType<typeof routerSocketProtocol>|undefined;
    try{
      await db.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,parent_id uuid,archived_at timestamptz,name text NOT NULL);
        CREATE TABLE memberships(workspace_id uuid NOT NULL,room_id uuid,identity_id text NOT NULL,role text NOT NULL,removed_at timestamptz);`);
      await db.query(DURABLE_LIVE_SCHEMA);await db.query(ROUTER_PROJECTION_SCHEMA);
      await db.query(`INSERT INTO workspaces VALUES($1)`,[WS]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Old baseline')`,[ROOM,WS]);
      await db.query(`INSERT INTO memberships VALUES($1,NULL,$3,'member',NULL),($1,$2,$3,'member',NULL)`,[WS,ROOM,VIEWER]);
      const live=new LiveHub();
      listener.on('notification',notification=>{
        if(notification.channel!=='beeline_live_v1'||!notification.payload)return;
        const payload=JSON.parse(notification.payload);if(Array.isArray(payload.journalStreams))live.journalChanged(payload.journalStreams);
      });
      await listener.connect();await listener.query('LISTEN beeline_live_v1');
      const phone=new PhoneService(db,'https://synthetic.test');let reads=0;
      phone.buildRouterValue=async(tx,args)=>{
        const value=(await tx.query<{name:string}>(`SELECT name FROM rooms WHERE id=$1`,[args.roomId])).rows[0]!;
        return {room:{id:args.roomId,name:value.name},messages:[]} as RouterValues['room-head'];
      };
      phone.readRouterSnapshot=async(args,viewer)=>{
        reads++;const value=await buildRouterSnapshot(db,args,viewer,phone.buildRouterValue.bind(phone));built.resolve();await release.promise;return value;
      };
      const lanes=new ReadLanes({origin:'https://synthetic.test',principal:VIEWER,sessionEpoch:1},()=>true);
      let applied=Promise.resolve(),to=0;
      const assembly=new RouterBatchAssembly(facts=>createHash('sha256').update(JSON.stringify(facts)).digest('hex'),batch=>{
        to=batch.to.through;applied=lanes.accept(batch);
      },()=>{throw new Error('Unexpected logical batch fault');});
      protocol=routerSocketProtocol(db,VIEWER,raw=>{
        const frame=JSON.parse(raw);if(frame.kind==='push-part'||frame.kind==='push-commit')assembly.accept(frame);
        if(frame.kind==='push-commit')delivered.resolve();
      },{families:['room-head'],listenerReady:()=>true,roomHeadContinuityV1:true},{live,phone,rooms:()=>[]});
      await protocol.handle({type:'router-negotiate',protocol:1,families:['room-head'],roomHeadContinuityV1:true,authorityFencesV1:true});
      lanes.connected(1,['room-head'],args=>protocol!.snapshot(args),{roomHeadContinuityV1:true});
      lanes.subscribe(input,()=>{if(lanes.peek(input).state==='LIVE'&&JSON.stringify(lanes.peek(input).value).includes('Committed new head'))installed.resolve();});
      lanes.demand(input,{}, {isCurrent:()=>true});await built.promise;
      // The existing durable journal and its committed wake are authored in
      // one writer transaction. The dedicated native LISTEN above is only a
      // test bridge; production continues to use its existing listener owner.
      await writer.transaction(async tx=>{
        await tx.query(`UPDATE rooms SET name='Committed new head' WHERE id=$1`,[ROOM]);
        await tx.query(`SELECT beeline_journal($1,jsonb_build_object('sourceTable','rooms','sourceRoomId',$2::text,'oldRoomId',$2::text,'newRoomId',$2::text,'operation','UPDATE'))`,[`workspace:${WS}`,ROOM]);
        await tx.query(`SELECT pg_notify('beeline_live_v1',jsonb_build_object('journalStreams',jsonb_build_array($1::text))::text)`,[`workspace:${WS}`]);
      });
      await delivered.promise;await applied;expect(lanes.peek(input).value).toBeNull();
      release.resolve();await installed.promise;
      expect(lanes.peek(input).cut?.through).toBe(to);expect(reads).toBe(1);
    }finally{
      release.resolve();protocol?.close();await listener.end();await Promise.all([db.close(),writer.close()]);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    }
  });
});
