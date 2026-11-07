import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase } from './test-support.js';
import { COMMITTED_JOURNAL_SCHEMA } from './committed-journal-schema.js';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion } from './command-completion.js';
import { MCP_MEMBER_STREAM_SCHEMA, serveMcpMemberStream } from './rooms-mcp-stream.js';
import type { PostgresDatabase, SqlDatabase } from './database.js';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';
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
      CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,archived_at timestamptz,parent_id uuid);
      CREATE TABLE room_access(room_id uuid,identity_id text,removed_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
      CREATE TABLE rooms_mcp_mentions(seq bigserial PRIMARY KEY,member_id text,room_id uuid,message_id text,cleared_at timestamptz);
      CREATE TABLE agent_commands(id text,agent_id text,reason text,state text,hiccup_attempts integer,private_payload jsonb,source_message_id text);
      CREATE TABLE rooms_mcp_members(client_id text,owner_id text,member_id text);
      CREATE TABLE rooms_mcp_tokens(hash text,client_id text,identity_id text,family_id text,scope text,expires_at timestamptz,revoked_at timestamptz,calls integer DEFAULT 0);
      CREATE TABLE rooms_mcp_connections(client_id text,identity_id text,scope text,revoked_at timestamptz);
      CREATE TABLE rooms_mcp_families(id text,client_id text,identity_id text,revoked_at timestamptz);`);
    await db.query(COMMITTED_JOURNAL_SCHEMA);await db.query(MCP_MEMBER_STREAM_SCHEMA);
    await db.query(`INSERT INTO rooms(id,workspace_id,archived_at) VALUES($1,$2,NULL)`,[room,workspace]);
    await db.query(`INSERT INTO room_access VALUES($1,'member',NULL)`,[room]);
    await db.query(`INSERT INTO memberships VALUES($1,NULL,'member','member',NULL),($1,$2,'member','member',NULL)`,[workspace,room]);
    await db.query(`INSERT INTO rooms_mcp_members VALUES('client','owner','member');
      INSERT INTO rooms_mcp_connections VALUES('client','owner','rooms:read',NULL);
      INSERT INTO rooms_mcp_tokens(hash,client_id,identity_id,scope,expires_at) VALUES('synthetic-token','client','owner','rooms:read',now()+interval '2 days');`);
  },30000);
  afterEach(()=>{for(const reply of replies.splice(0))reply.end();vi.useRealTimers();});
  afterAll(async()=>{await release?.();await closeDatabase?.();});
  const page=()=>vi.fn(async(transaction:SqlDatabase,after:string)=>{
    const mentions=(await transaction.query<{id:string;room_id:string;deliveryCursor:string}>(
      `SELECT message_id id,room_id,'Synthetic committed message' text,seq::text "deliveryCursor" FROM rooms_mcp_mentions
       WHERE member_id='member' AND seq>$1 AND cleared_at IS NULL ORDER BY seq`,[after])).rows;
    return {mentions,wakes:[],nextCursor:mentions.at(-1)?.deliveryCursor??after,more:false};
  });
  const reply=()=>{const result=new Reply();replies.push(result);return result;};

  it('has no idle reads or empty frames for a day, then captures the real committed source',async()=>{
    vi.useFakeTimers({toFake:['Date']});
    const output=reply(),read=page();
    await serveMcpMemberStream(db,principal,output as unknown as ServerResponse,{mentionCursor:'0'},read as never);
    expect(output.frames).toHaveLength(1);expect(read).toHaveBeenCalledTimes(1);
    const queries=vi.spyOn(db,'query'),transactions=vi.spyOn(db,'transaction');
    vi.setSystemTime(Date.now()+24*60*60*1000);
    expect(output.frames).toHaveLength(1);expect(read).toHaveBeenCalledTimes(1);
    expect(queries).not.toHaveBeenCalled();expect(transactions).not.toHaveBeenCalled();
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
  it('refreshes the joined Claude bridge once after database-clock expiry, replays the missed tag once, and parks on revocation',async()=>{
    const proofRoot=fileURLToPath(new URL('../../../.beeline-proof/',import.meta.url));mkdirSync(proofRoot,{recursive:true});
    const dir=mkdtempSync(join(proofRoot,'mcp-expiry-')),stateDir=join(dir,'state'),socket=join(dir,'claude.sock');
    const key=`claude-code:${dir}`,connections:{output:Reply;url:URL;token:string}[]=[],messages:string[]=[],refreshes:unknown[]=[];
    const events=new EventEmitter(),deadline=AbortSignal.timeout(10_000);
    const until=(ready:()=>boolean)=>new Promise<void>((resolve,reject)=>{
      const stop=()=>{events.off('change',inspect);reject(new Error('Joined bridge expiry proof did not advance'));};
      const inspect=()=>{if(ready()){events.off('change',inspect);deadline.removeEventListener('abort',stop);resolve();}};
      if(deadline.aborted){stop();return;}
      deadline.addEventListener('abort',stop,{once:true});events.on('change',inspect);inspect();
    });
    let releaseRefresh!:()=>void;
    const refreshGate=new Promise<void>(resolve=>{releaseRefresh=resolve;});
    const read=page();
    const http=createServer((request,response)=>{void(async()=>{
      const url=new URL(request.url!,'http://127.0.0.1');
      if(url.pathname==='/mcp/oauth/token'){
        let body='';for await(const chunk of request)body+=chunk;
        refreshes.push(JSON.parse(body));events.emit('change');await refreshGate;
        await db.query(`INSERT INTO rooms_mcp_tokens(hash,client_id,identity_id,scope,expires_at)
          VALUES('fresh-token','client','owner','rooms:read',now()+interval '1 hour')`);
        response.setHeader('content-type','application/json');
        response.end(JSON.stringify({access_token:'fresh-token',refresh_token:'fresh-refresh',expires_in:3600}));return;
      }
      const token=request.headers.authorization?.replace('Bearer ','')??'';
      const allowed=await db.query(`SELECT hash FROM rooms_mcp_tokens WHERE hash=$1 AND revoked_at IS NULL AND expires_at>now()`,[token]);
      if(!allowed.rowCount){response.writeHead(401);response.end();return;}
      if(url.pathname==='/mcp'){
        response.setHeader('content-type','application/json');
        response.end(JSON.stringify({result:{capabilities:{memberStreamV1:true}}}));return;
      }
      const output=reply();connections.push({output,url,token});
      response.writeHead(200,{'content-type':'application/x-ndjson'});response.flushHeaders();
      output.on('frame',()=>{response.write(JSON.stringify(output.frames.at(-1))+'\n');events.emit('change');});
      output.once('close',()=>response.end());response.once('close',()=>output.end());
      await serveMcpMemberStream(db,{...principal,hash:token},output as unknown as ServerResponse,
        {mentionCursor:url.searchParams.get('mentions')!,cursor:url.searchParams.has('cursor')?JSON.parse(url.searchParams.get('cursor')!):undefined},read);
    })().catch(error=>{response.destroy(error as Error);});});
    const claude=createSocketServer(peer=>{
      let text='';peer.on('data',chunk=>{text+=chunk;});
      peer.on('end',()=>{messages.push(JSON.parse(text).message.content);events.emit('change');});
    });
    http.listen(0,'127.0.0.1');claude.listen(socket);await Promise.all([once(http,'listening'),once(claude,'listening')]);
    const server=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
    const env={...process.env,HOME:dir,XDG_CONFIG_HOME:dir,XDG_STATE_HOME:dir,CLAUDE_CONFIG_DIR:join(dir,'.claude'),CODEX_HOME:join(dir,'.codex')};
    mkdirSync(join(env.CLAUDE_CONFIG_DIR,'sessions'),{recursive:true});
    writeFileSync(join(env.CLAUDE_CONFIG_DIR,'sessions',`${process.pid}.json`),JSON.stringify({pid:process.pid,sessionId:'expiry-proof',cwd:dir,messagingSocketPath:socket}));
    await updateState(stateDir,state=>state.sessions.push({key,agent:'claude-code',cwd:dir,name:'Claude',server,clientId:'client',
      refreshToken:'synthetic-refresh',accessToken:principal.hash,accessExpiresAt:Date.now()+3_600_000,
      cursor:'1',deliveredWakes:[],joinedAt:'',sessionId:'expiry-proof',pid:process.pid}));
    const stateWatch=watch(stateDir,()=>events.emit('change'));
    const bridge=fileURLToPath(new URL('../../body/src/session-join/bridge.ts',import.meta.url));
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',
      `import {runBridge} from ${JSON.stringify(bridge)};await runBridge(${JSON.stringify(stateDir)},{node:process.execPath,bundle:${JSON.stringify(bridge)}});`],
      {env,stdio:['ignore','ignore','inherit']});
    try{
      await until(()=>!!readState(stateDir).sessions[0]?.streamCursor);
      await db.query(`INSERT INTO rooms_mcp_mentions(member_id,room_id,message_id) VALUES('member',$1,'before-expiry')`,[room]);
      await until(()=>messages.length===1&&readState(stateDir).sessions[0]?.cursor!=='1');
      expect(messages[0]).toContain('message before-expiry');
      // Use PostgreSQL's actual clock. The local token deliberately still looks
      // valid for an hour, so recovery must invalidate the rejected token.
      const expiry=(await db.query<{expires_at:Date}>(`UPDATE rooms_mcp_tokens SET expires_at=clock_timestamp()+interval '200 milliseconds'
        WHERE hash='synthetic-token' RETURNING expires_at`)).rows[0]!.expires_at;
      const head=(await db.query<{through:number}>(`SELECT sequence::integer through FROM live_streams WHERE id='mcp:member'`)).rows[0]!.through;
      await until(()=>readState(stateDir).sessions[0]?.streamCursor?.through===head);
      const saved=readState(stateDir).sessions[0]!;
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiry.getTime()-Date.now())+25));
      expect((await db.query<{expired:boolean}>(`SELECT expires_at<=clock_timestamp() expired FROM rooms_mcp_tokens WHERE hash='synthetic-token'`)).rows[0]?.expired).toBe(true);
      const ended=once(connections[0]!.output,'close');
      await db.query(`INSERT INTO rooms_mcp_mentions(member_id,room_id,message_id) VALUES('member',$1,'during-expiry')`,[room]);
      await ended;
      expect(connections[0]!.output.frames.at(-1)).toEqual({v:1,type:'ended',reason:'expired'});
      await until(()=>refreshes.length===1);
      expect(messages).toHaveLength(1);expect(connections).toHaveLength(1);
      expect(refreshes[0]).toMatchObject({grant_type:'refresh_token',refresh_token:'synthetic-refresh',client_id:'client'});
      releaseRefresh();
      await until(()=>messages.length===2&&connections.length===2&&!!readState(stateDir).sessions[0]?.streamCursor&&
        readState(stateDir).sessions[0]!.streamCursor!.through>saved.streamCursor!.through);
      expect(connections[1]!.token).toBe('fresh-token');
      expect(connections[1]!.url.searchParams.get('mentions')).toBe(saved.cursor);
      expect(JSON.parse(connections[1]!.url.searchParams.get('cursor')!)).toEqual(saved.streamCursor);
      expect(messages[1]).toContain('message during-expiry');
      expect(messages.filter(text=>text.includes('message during-expiry'))).toHaveLength(1);
      expect(readState(stateDir).sessions[0]).toMatchObject({accessToken:'fresh-token',refreshToken:'fresh-refresh'});
      const revoked=once(connections[1]!.output,'close');
      await db.query(`UPDATE rooms_mcp_connections SET revoked_at=now()`);await revoked;
      expect(connections[1]!.output.frames.at(-1)).toEqual({v:1,type:'ended',reason:'unavailable'});
      await db.query(`INSERT INTO rooms_mcp_mentions(member_id,room_id,message_id) VALUES('member',$1,'after-revocation')`,[room]);
      await new Promise(resolve=>setTimeout(resolve,100));
      expect(refreshes).toHaveLength(1);expect(connections).toHaveLength(2);expect(messages).toHaveLength(2);
    }finally{
      releaseRefresh();stateWatch.close();
      if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
      http.closeAllConnections();await Promise.all([new Promise<void>(resolve=>http.close(()=>resolve())),new Promise<void>(resolve=>claude.close(()=>resolve()))]);
      await db.query(`UPDATE rooms_mcp_tokens SET expires_at=now()+interval '2 days' WHERE hash='synthetic-token';
        DELETE FROM rooms_mcp_tokens WHERE hash='fresh-token';UPDATE rooms_mcp_connections SET revoked_at=NULL;
        DELETE FROM rooms_mcp_mentions WHERE message_id IN ('before-expiry','during-expiry','after-revocation');`);
      rmSync(dir,{recursive:true,force:true});
    }
  });
  it('ends a held stream on actual committed credential revocation without returning content',async()=>{
    const output=reply(),read=page();
    await serveMcpMemberStream(db,principal,output as unknown as ServerResponse,{mentionCursor:'1'},read as never);
    const ended=output.until(2);
    await db.query(`UPDATE rooms_mcp_tokens SET revoked_at=now() WHERE hash='synthetic-token'`);
    await ended;expect(output.frames[1]).toEqual({v:1,type:'ended',reason:'unavailable'});
    expect(output.writableEnded).toBe(true);expect(read).toHaveBeenCalledTimes(1);
  });
  it.each(['token','consent','family','member','scope'])('keeps %s revocation terminal even when the access token has expired',async authority=>{
    try{
      await db.query(`UPDATE rooms_mcp_tokens SET revoked_at=NULL,expires_at=now()-interval '1 second' WHERE hash='synthetic-token'`);
      if(authority==='token')await db.query(`UPDATE rooms_mcp_tokens SET revoked_at=now()`);
      if(authority==='consent')await db.query(`UPDATE rooms_mcp_connections SET revoked_at=now()`);
      if(authority==='family'){
        await db.query(`INSERT INTO rooms_mcp_families VALUES('revoked-family','client','owner',now());
          UPDATE rooms_mcp_tokens SET family_id='revoked-family'`);
      }
      if(authority==='member')await db.query(`DELETE FROM rooms_mcp_members`);
      if(authority==='scope')await db.query(`UPDATE rooms_mcp_connections SET scope='rooms:write'`);
      const output=reply(),read=page();
      await serveMcpMemberStream(db,principal,output as unknown as ServerResponse,{mentionCursor:'1'},read);
      expect(output.frames).toEqual([{v:1,type:'ended',reason:'unavailable'}]);expect(read).not.toHaveBeenCalled();
    }finally{
      await db.query(`UPDATE rooms_mcp_tokens SET revoked_at=NULL,expires_at=now()+interval '2 days',family_id=NULL;
        UPDATE rooms_mcp_connections SET revoked_at=NULL,scope='rooms:read';DELETE FROM rooms_mcp_families;`);
      if(authority==='member')await db.query(`INSERT INTO rooms_mcp_members VALUES('client','owner','member')`);
    }
  });
  it('reports expiry at the final credential fence without releasing prepared content',async()=>{
    const output=reply(),read=page();let transactions=0;
    const observed:SqlDatabase={query:(sql,values)=>db.query(sql,values),transaction:async work=>{
      const result=await db.transaction(work);
      if(++transactions===1)await db.query(`UPDATE rooms_mcp_tokens SET expires_at=clock_timestamp()-interval '1 second'`);
      return result;
    }};
    try{
      await serveMcpMemberStream(observed,principal,output as unknown as ServerResponse,{mentionCursor:'0'},read);
      expect(read).toHaveBeenCalledTimes(1);expect(transactions).toBe(1);
      expect(output.frames).toEqual([{v:1,type:'ended',reason:'expired'}]);
    }finally{await db.query(`UPDATE rooms_mcp_tokens SET expires_at=now()+interval '2 days'`);}
  });
});
