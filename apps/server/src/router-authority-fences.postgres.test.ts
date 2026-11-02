import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import {PostgresDatabase,type SqlDatabase} from './database.js';
import {DURABLE_LIVE_SCHEMA} from './durable-live.js';
import {ROUTER_PROJECTION_SCHEMA} from './router-projection-schema.js';
import {subscribeAuthorityFences,currentAuthorityFence} from './router-authority-fences.js';
import {readRouterAuthority} from './router-projections.js';
import {LiveHub} from './live.js';
const postgresUrl=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(postgresUrl&&!['127.0.0.1','localhost','[::1]'].includes(new URL(postgresUrl).hostname))throw new Error('authority proofs require isolated loopback PostgreSQL');
const WORKSPACE='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222',VIEWER='synthetic-reader';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
describe.skipIf(!postgresUrl)('P6 independent authority control final enqueue',()=>{
  it('serializes a content-free denial against regrant and never advances a data cursor',async()=>{
    const schema=`authority_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:postgresUrl,max:1});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:postgresUrl,options:`-c search_path=${schema},public`,max:2};
    const database=new PostgresDatabase('',2,{pool:new Pool(config)}),writer=new PostgresDatabase('',2,{pool:new Pool(config)});
    const reached=deferred(),releaseFence=deferred(),sent=deferred();let release:(()=>void)|undefined;const frames:Record<string,any>[]=[];
    try{
      await database.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);`);
      await database.query(DURABLE_LIVE_SCHEMA);await database.query(ROUTER_PROJECTION_SCHEMA);
      await database.query(`INSERT INTO workspaces VALUES($1)`,[WORKSPACE]);
      await database.query(`INSERT INTO rooms(id,workspace_id) VALUES($1,$2)`,[ROOM,WORKSPACE]);
      await database.query(`INSERT INTO memberships VALUES($1,NULL,$2,'member',NULL),($1,$3,$2,'member',NULL)`,[WORKSPACE,VIEWER,ROOM]);
      const observed:SqlDatabase={query:(sql,args)=>database.query(sql,args),transaction:work=>database.transaction(tx=>work({
        transaction:nested=>tx.transaction(nested),query:async(sql,args)=>{const result=await tx.query(sql,args);
          if(sql.includes('pg_advisory_xact_lock_shared')){reached.resolve();await releaseFence.promise;}return result;},
      }))};
      const live=new LiveHub();release=await subscribeAuthorityFences(observed,live,VIEWER,frame=>{frames.push(frame);if(frame.mode==='advance')sent.resolve();return undefined;},reason=>{throw new Error(reason);});
      await writer.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`,[VIEWER,ROOM]);
      live.journalChanged([`authority:${VIEWER}`]);await reached.promise;
      await expect(writer.transaction(async tx=>{await tx.query("SET LOCAL lock_timeout='100ms'");
        await tx.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id=$1 AND room_id=$2`,[VIEWER,ROOM]);
      })).rejects.toMatchObject({code:'55P03'});
      expect(frames).toHaveLength(0);releaseFence.resolve();await sent.promise;
      expect(frames).toHaveLength(2);expect(frames[0]).toMatchObject({kind:'authority-fence',scope:ROOM,authorityScope:`room:${ROOM}`,mode:'deny'});
      expect(frames[1]).toMatchObject({mode:'advance',authorityScope:`reader:${VIEWER}:workspace:${WORKSPACE}:visibility`});
      for(const frame of frames){expect(frame).not.toHaveProperty('cut');expect(frame).not.toHaveProperty('to');}
      await writer.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id=$1 AND room_id=$2`,[VIEWER,ROOM]);
      const granted=await readRouterAuthority(database,{family:'room-head',workspaceId:WORKSPACE,roomId:ROOM},VIEWER);
      expect(BigInt(granted.scopes.find(item=>item.authorityScope===`room:${ROOM}`)!.epoch)).toBeGreaterThan(BigInt(frames[0]!.authority.scopes[0].epoch));
      expect(await currentAuthorityFence(database,VIEWER,ROOM,`room:${ROOM}`)).toBeUndefined();
    }finally{
      releaseFence.resolve();release?.();await Promise.all([database.close(),writer.close()]);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    }
  });
});
