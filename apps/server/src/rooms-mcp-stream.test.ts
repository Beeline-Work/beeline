import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase } from './test-support.js';
import { DURABLE_LIVE_SCHEMA } from './durable-live.js';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion } from './command-completion.js';
import { MCP_MEMBER_STREAM_SCHEMA, serveMcpMemberStream } from './rooms-mcp-stream.js';
import type { PostgresDatabase, SqlDatabase } from './database.js';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';
import { GroupBClock } from './test-fixtures/router-group-b-clock.js';
import { acceptMemberDelivery } from '../../body/src/session-join/bridge.js';
import { queueInboxOnce, readState, takeInbox, updateState } from '../../body/src/session-join/store.js';

class Reply extends EventEmitter {
  destroyed=false;writableEnded=false;writableLength=0;
  frames:Record<string,any>[]=[];
  writeHead(){} flushHeaders(){}
  write(text:string){this.frames.push(JSON.parse(text));this.emit('frame');return true;}
  end(){this.writableEnded=true;this.emit('close');}
  until(count:number):Promise<void>{
    if(this.frames.length>=count)return Promise.resolve();
    return new Promise(resolve=>{const inspect=()=>{if(this.frames.length>=count){this.off('frame',inspect);resolve();}};this.on('frame',inspect);});
  }
}
const principal={hash:'synthetic-token',client_id:'client',identity_id:'owner',member_id:'member',scope:'rooms:read'};
const room='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222';

const postgresUrl=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
describe.each(['pglite',...(postgresUrl?['postgres']:[])])('P12 MCP committed member stream (%s)',backend=>{
  let db:PgliteDatabase|PostgresDatabase,release:()=>Promise<void>,closeDatabase:()=>Promise<void>;
  const replies:Reply[]=[];
  beforeAll(async()=>{
    if(backend==='postgres'){
      const fixture=await groupBPostgresDatabase(postgresUrl!,false);db=fixture.database;closeDatabase=fixture.close;
      release=await fixture.listenToCompletions();
    }else{
      const local=new PgliteDatabase();db=local;closeDatabase=()=>local.close();
      release=await local.client.listen(COMMAND_COMPLETION_CHANNEL,notifyCommandCompletion);
    }
    // Minimal isolated fixture still installs the actual production journal and
    // every actual stream trigger; no test manually fabricates notifications.
    await db.query(`CREATE TABLE router_authority(scope text PRIMARY KEY,epoch bigint NOT NULL DEFAULT 1);
      CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,archived_at timestamptz);
      CREATE TABLE room_access(room_id uuid,identity_id text,removed_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
      CREATE TABLE rooms_mcp_mentions(seq bigserial PRIMARY KEY,member_id text,room_id uuid,message_id text,cleared_at timestamptz,rewakes integer DEFAULT 0);
      CREATE TABLE agent_commands(id text,agent_id text,reason text,state text,hiccup_attempts integer,private_payload jsonb,source_message_id text);
      CREATE TABLE rooms_mcp_members(client_id text,owner_id text,member_id text);
      CREATE TABLE rooms_mcp_tokens(hash text,client_id text,identity_id text,family_id text,scope text,expires_at timestamptz,revoked_at timestamptz,calls integer DEFAULT 0);
      CREATE TABLE rooms_mcp_connections(client_id text,identity_id text,scope text,revoked_at timestamptz);
      CREATE TABLE rooms_mcp_families(id text,client_id text,identity_id text,revoked_at timestamptz);`);
    await db.query(DURABLE_LIVE_SCHEMA);await db.query(MCP_MEMBER_STREAM_SCHEMA);
    await db.query(`INSERT INTO rooms VALUES($1,$2,NULL)`,[room,workspace]);
    await db.query(`INSERT INTO room_access VALUES($1,'member',NULL)`,[room]);
    await db.query(`INSERT INTO memberships VALUES($1,NULL,'member','member',NULL)`,[workspace]);
    await db.query(`INSERT INTO rooms_mcp_members VALUES('client','owner','member');
      INSERT INTO rooms_mcp_connections VALUES('client','owner','rooms:read',NULL);
      INSERT INTO rooms_mcp_tokens(hash,client_id,identity_id,scope,expires_at) VALUES('synthetic-token','client','owner','rooms:read',now()+interval '2 days');`);
  },30000);
  afterEach(()=>{for(const reply of replies.splice(0))reply.end();vi.useRealTimers();});
  afterAll(async()=>{await release?.();await closeDatabase?.();});
  const page=()=>vi.fn(async(transaction:SqlDatabase,after:string)=>{
    const mentions=(await transaction.query<{id:string;room_id:string;deliveryCursor:string;rewakes:number}>(
      `SELECT message_id id,room_id,'Synthetic committed message' text,seq::text "deliveryCursor",rewakes FROM rooms_mcp_mentions
       WHERE member_id='member' AND seq>$1 AND cleared_at IS NULL ORDER BY seq`,[after])).rows;
    return {mentions,wakes:[],nextCursor:mentions.at(-1)?.deliveryCursor??after,more:false};
  });
  const reply=()=>{const result=new Reply();replies.push(result);return result;};

  it('has no idle reads or empty frames for a day, then captures the real committed source',async()=>{
    vi.useFakeTimers({toFake:['Date']});const clock=new GroupBClock();
    const output=reply(),read=page();
    await serveMcpMemberStream(db,principal,output as unknown as ServerResponse,{mentionCursor:'0'},read as never,clock);
    expect(output.frames).toHaveLength(1);expect(read).toHaveBeenCalledTimes(1);
    const queries=vi.spyOn(db,'query'),transactions=vi.spyOn(db,'transaction');
    vi.setSystemTime(Date.now()+24*60*60*1000);clock.advanceBy(24*60*60*1000);
    expect(output.frames).toHaveLength(1);expect(read).toHaveBeenCalledTimes(1);
    expect(queries).not.toHaveBeenCalled();expect(transactions).not.toHaveBeenCalled();
    expect(clock.size).toBe(1); // Only the stored credential's terminal expiry.
    queries.mockRestore();transactions.mockRestore();vi.useRealTimers();
    const delivered=output.until(3);
    await db.query(`INSERT INTO rooms_mcp_mentions(member_id,room_id,message_id) VALUES('member',$1,'first')`,[room]);
    await delivered;
    expect(output.frames[1]).toMatchObject({type:'delivery',deliveryId:'mention:first:0',mentionCursor:'1'});
    expect(output.frames[2]).toMatchObject({type:'checkpoint',cursor:{through:1}});
    expect(read).toHaveBeenCalledTimes(2);
    const proofRoot=fileURLToPath(new URL('../../../.beeline-proof/',import.meta.url));mkdirSync(proofRoot,{recursive:true});
    const dir=mkdtempSync(join(proofRoot,'mcp-durability-')),key='codex:/synthetic/project';
    const runner={node:'/synthetic/node',bundle:'/synthetic/beeline.js'};
    try{
      await updateState(dir,state=>state.sessions.push({key,agent:'codex',cwd:'/synthetic/project',name:'synthetic',
        server:'http://127.0.0.1',clientId:'client',refreshToken:'synthetic-refresh',cursor:'0',deliveredWakes:[],joinedAt:''}));
      const frame=output.frames[1]!;
      // Crash after durable inbox publication but before the state/cursor write.
      expect(queueInboxOnce(dir,key,String(frame.deliveryId),'already persisted')).toBe(true);
      expect(readState(dir).sessions[0]?.cursor).toBe('0');
      expect(await acceptMemberDelivery(dir,key,runner,frame)).toBe(0);
      expect(readState(dir).sessions[0]?.streamCursor).toBeUndefined();
      expect(takeInbox(dir,key)).toBe('already persisted');
      expect(await acceptMemberDelivery(dir,key,runner,frame)).toBe(0);expect(takeInbox(dir,key)).toBe('');
      await acceptMemberDelivery(dir,key,runner,output.frames[2]);
      expect(readState(dir).sessions[0]?.streamCursor).toEqual(output.frames[2]!.cursor);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it('resumes an unchanged committed cursor without requerying the application inbox',async()=>{
    const head=(await db.query<{epoch:string;through:number}>(`SELECT epoch,sequence::integer through FROM live_streams WHERE id='mcp:member'`)).rows[0]!;
    const output=reply(),read=page();
    await serveMcpMemberStream(db,principal,output as unknown as ServerResponse,{cursor:head,mentionCursor:'1'},read as never);
    expect(read).not.toHaveBeenCalled();expect(output.frames).toEqual([{v:1,type:'checkpoint',cursor:head,mentionCursor:'1'}]);
  });
  it('does not publish a rolled-back source or unrelated token-use metrics',async()=>{
    const output=reply(),read=page();
    await serveMcpMemberStream(db,principal,output as unknown as ServerResponse,{mentionCursor:'1'},read as never);
    const before=(await db.query(`SELECT sequence FROM live_streams WHERE id='mcp:member'`)).rows;
    await expect(db.transaction(async tx=>{
      await tx.query(`INSERT INTO rooms_mcp_mentions(member_id,room_id,message_id) VALUES('member',$1,'rollback')`,[room]);throw new Error('abort');
    })).rejects.toThrow('abort');
    await db.query(`UPDATE rooms_mcp_tokens SET calls=calls+1`);
    expect((await db.query(`SELECT sequence FROM live_streams WHERE id='mcp:member'`)).rows).toEqual(before);
    expect(output.frames).toHaveLength(1);expect(read).toHaveBeenCalledTimes(1);
  });
  it('ends a held stream on actual committed credential revocation without returning content',async()=>{
    const output=reply(),read=page();
    await serveMcpMemberStream(db,principal,output as unknown as ServerResponse,{mentionCursor:'1'},read as never);
    const ended=output.until(2);
    await db.query(`UPDATE rooms_mcp_tokens SET revoked_at=now() WHERE hash='synthetic-token'`);
    await ended;expect(output.frames[1]).toEqual({v:1,type:'ended',reason:'unavailable'});
    expect(output.writableEnded).toBe(true);expect(read).toHaveBeenCalledTimes(1);
  });
});
