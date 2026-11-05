import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import {PostgresDatabase,type SqlDatabase} from './database.js';
import {DURABLE_LIVE_SCHEMA} from './durable-live.js';
import {MEDIA_AUTHORITY_SCHEMA} from './media-authority-schema.js';
import {readMediaMetadata,fenceMediaMetadataEnqueue} from './phone-media.js';
import {ROUTER_PROJECTION_SCHEMA} from './router-projection-schema.js';
const postgresUrl=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(postgresUrl && !['127.0.0.1','localhost','[::1]'].includes(new URL(postgresUrl).hostname))throw new Error('media proofs require isolated loopback PostgreSQL');
const OBJECT='33333333-3333-4333-8333-333333333333',VIEWER='synthetic-owner';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

describe.skipIf(!postgresUrl)('P6 media metadata current-authority enqueue fence',()=>{
  it.each(['expiry','reference','owner'] as const)('serializes %s revocation with the actual synchronous enqueue',async(kind)=>{
    const schema=`media_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:postgresUrl,max:1});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:postgresUrl,options:`-c search_path=${schema},public`,max:2};
    const db=new PostgresDatabase('',2,{pool:new Pool(config)}),revoker=new PostgresDatabase('',2,{pool:new Pool(config)});
    const reached=deferred(),release=deferred();let pending:Promise<void>|undefined,enqueued=0;
    const revoke=async(tx:SqlDatabase)=>{
      if(kind==='expiry')await tx.query(`INSERT INTO object_expirations(id) VALUES($1)`,[OBJECT]);
      else if(kind==='reference')await tx.query(`UPDATE messages SET attachments='[]'::jsonb WHERE id='reference'`);
      else await tx.query(`UPDATE objects SET owner_id='new-owner' WHERE id=$1`,[OBJECT]);
    };
    try{
      await db.query(`CREATE TABLE workspaces(id uuid PRIMARY KEY);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,parent_id uuid,archived_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
        CREATE VIEW room_access AS SELECT * FROM memberships;
        CREATE TABLE objects(id uuid PRIMARY KEY,owner_id text,key text,sha256 text,size bigint,mime text,state text,expires_at timestamptz);
        CREATE TABLE object_expirations(id uuid PRIMARY KEY);
        CREATE TABLE messages(id text PRIMARY KEY,room_id uuid,author_id text,attachments jsonb,deleted_at timestamptz);`);
      await db.query(DURABLE_LIVE_SCHEMA);await db.query(ROUTER_PROJECTION_SCHEMA);await db.query(MEDIA_AUTHORITY_SCHEMA);
      await db.query(`INSERT INTO objects VALUES($1,$2,'immutable/key',$3,10,'image/webp','ready','2099-01-01')`,[OBJECT,VIEWER,'a'.repeat(64)]);
      await db.query(`INSERT INTO messages(id,attachments) VALUES('reference',$1::jsonb)`,[JSON.stringify([{url:`/v1/media/${OBJECT}`}])]);
      const metadata=await readMediaMetadata(db,OBJECT,VIEWER);
      const observed:SqlDatabase={query:(sql,args)=>db.query(sql,args),transaction:work=>db.transaction(tx=>work({
        transaction:nested=>tx.transaction(nested),query:async(sql,args)=>{const result=await tx.query(sql,args);
          if(sql.includes('pg_advisory_xact_lock_shared')){reached.resolve();await release.promise;}return result;},
      }))};
      pending=fenceMediaMetadataEnqueue(observed,OBJECT,VIEWER,metadata.authority,()=>{enqueued++;return undefined;});await reached.promise;
      await expect(revoker.transaction(async tx=>{await tx.query("SET LOCAL lock_timeout='100ms'");await revoke(tx);})).rejects.toMatchObject({code:'55P03'});
      expect(enqueued).toBe(0);release.resolve();await pending;expect(enqueued).toBe(1);
      await revoker.transaction(revoke);
      await expect(fenceMediaMetadataEnqueue(db,OBJECT,VIEWER,metadata.authority,()=>{enqueued++;return undefined;})).rejects.toMatchObject({status:kind==='reference'?409:404});
      expect(enqueued).toBe(1);
    }finally{
      release.resolve();await pending?.catch(()=>{});await Promise.all([db.close(),revoker.close()]);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    }
  });
});
