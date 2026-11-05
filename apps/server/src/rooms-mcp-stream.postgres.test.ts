import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresDatabase, type SqlDatabase } from './database.js';
import { COMMITTED_JOURNAL_SCHEMA } from './committed-journal-schema.js';
import { MCP_MEMBER_STREAM_SCHEMA, serveMcpMemberStream } from './rooms-mcp-stream.js';
const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if(url&&!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('MCP proof requires isolated loopback PostgreSQL');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};};
class Reply extends EventEmitter {
  destroyed=false;writableEnded=false;writableLength=0;frames:Record<string,unknown>[]=[];
  writeHead(){}flushHeaders(){}write(text:string){this.frames.push(JSON.parse(text));return true;}
  end(){this.writableEnded=true;this.emit('close');}
}
describe.skipIf(!url)('MCP real PostgreSQL final authority contention',()=>{
  it('blocks final enqueue behind the actual revocation writer and never releases prepared private content',async()=>{
    const schema='mcp_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url,max:1});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const config={connectionString:url,options:`-c search_path=${schema},public`,max:2};
    const first=new PostgresDatabase('',2,{pool:new Pool(config)}),second=new PostgresDatabase('',2,{pool:new Pool(config)});
    const room='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222';
    const pageEntered=deferred(),allowPage=deferred(),writerHeld=deferred(),commitWriter=deferred(),fenceEntered=deferred();
    const output=new Reply();let revoke:Promise<void>|undefined;
    try{
      await first.query(`CREATE TABLE router_authority(scope text PRIMARY KEY,epoch bigint NOT NULL DEFAULT 1);
        CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,archived_at timestamptz);
        CREATE TABLE room_access(room_id uuid,identity_id text,removed_at timestamptz);
        CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
        CREATE TABLE rooms_mcp_mentions(seq bigserial PRIMARY KEY,member_id text,room_id uuid,message_id text,cleared_at timestamptz,rewakes integer DEFAULT 0);
        CREATE TABLE agent_commands(id text,agent_id text,reason text,state text,hiccup_attempts integer,private_payload jsonb,source_message_id text);
        CREATE TABLE rooms_mcp_members(client_id text,owner_id text,member_id text);
        CREATE TABLE rooms_mcp_tokens(hash text,client_id text,identity_id text,family_id text,scope text,expires_at timestamptz,revoked_at timestamptz);
        CREATE TABLE rooms_mcp_connections(client_id text,identity_id text,scope text,revoked_at timestamptz);
        CREATE TABLE rooms_mcp_families(id text,client_id text,identity_id text,revoked_at timestamptz);`);
      await first.query(COMMITTED_JOURNAL_SCHEMA);await first.query(MCP_MEMBER_STREAM_SCHEMA);
      await first.query(`INSERT INTO rooms VALUES($1,$2,NULL)`,[room,workspace]);
      await first.query(`INSERT INTO room_access VALUES($1,'member',NULL)`,[room]);
      await first.query(`INSERT INTO memberships VALUES($1,NULL,'member','member',NULL)`,[workspace]);
      await first.query(`INSERT INTO rooms_mcp_members VALUES('client','owner','member');
        INSERT INTO rooms_mcp_connections VALUES('client','owner','rooms:read',NULL);
        INSERT INTO rooms_mcp_tokens VALUES('synthetic-token','client','owner',NULL,'rooms:read',now()+interval '1 hour',NULL);`);
      const observed:SqlDatabase={query:(sql,values)=>first.query(sql,values),transaction:work=>first.transaction(tx=>work({
        transaction:nested=>tx.transaction(nested),query:(sql,values)=>{
          const pending=tx.query(sql,values);
          if(sql.includes('pg_advisory_xact_lock_shared'))fenceEntered.resolve();
          return pending;
        },
      }))};
      const serving=serveMcpMemberStream(observed,{hash:'synthetic-token',client_id:'client',identity_id:'owner',member_id:'member',scope:'rooms:read'},
        output as unknown as ServerResponse,{mentionCursor:'0'},async()=>{
          pageEntered.resolve();await allowPage.promise;
          return {mentions:[{id:'synthetic-message',room_id:room,text:'private prepared content',deliveryCursor:'1'}],wakes:[],nextCursor:'1',more:false};
        });
      await pageEntered.promise;
      revoke=second.transaction(async tx=>{
        // Actual production BEFORE trigger obtains exclusive authority lock.
        await tx.query(`UPDATE rooms_mcp_tokens SET revoked_at=now() WHERE hash='synthetic-token'`);
        writerHeld.resolve();await commitWriter.promise;
      });
      await writerHeld.promise;allowPage.resolve();await fenceEntered.promise;
      expect(output.frames).toEqual([]);
      commitWriter.resolve();await revoke;await serving;
      expect(output.frames).toEqual([{v:1,type:'ended',reason:'unavailable'}]);expect(output.writableEnded).toBe(true);
    }finally{
      allowPage.resolve();commitWriter.resolve();await revoke?.catch(()=>undefined);output.end();
      await Promise.all([first.close(),second.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    }
  },15000);
});
