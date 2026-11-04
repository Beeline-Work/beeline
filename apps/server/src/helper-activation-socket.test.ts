import { pendingMcpWakes } from './rooms-mcp-agent.js';
import { HelperFrameReader } from '@beeline/net/helper-codecs';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';
import type { SqlDatabase } from './database.js';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import type { TokenAuth } from './auth.js';
import type { ConnectionPresence } from './connection-presence.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import type { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { migratedDatabase } from './test-support.js';
import { HELPER_ACTIVATION_SCHEMA } from './helper-activation-schema.js';
import { MACHINE_SOCKET_PROTOCOL } from './daemon-live.js';
const owner='a'.repeat(64),agent='b'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const identity={agentId:agent,workspaceId:workspace,roomId:room,commandId:'socket-command',generationId:'socket-generation'};
const token='bdt_'+'s'.repeat(43);
describe('actual activation registration and final socket enqueue',()=>{
  let db:SqlDatabase,closeDatabase:()=>Promise<void>,daemon:DaemonService,server:ReturnType<typeof createBeelineServer>,socket:WebSocket,port:number,epoch=0;
  const frames:Array<Record<string,any>>=[];
  const next=async(predicate:(frame:Record<string,any>)=>boolean)=>{let found:Record<string,any>|undefined;await vi.waitFor(()=>{found=frames.find(predicate);expect(found).toBeDefined();});return found!;};
  const send=(frame:Record<string,unknown>)=>socket.send(JSON.stringify({agentId:agent,...frame}));
  beforeAll(async()=>{
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1','1');
    const url=process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
    if(url){const fixture=await groupBPostgresDatabase(url);db=fixture.database;closeDatabase=fixture.close;}
    else{const local=await migratedDatabase();db=local;closeDatabase=()=>local.close();}await db.query(HELPER_ACTIVATION_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Agent')`,[owner,agent]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[agent,owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Activation socket')`,[workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`,[room,workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,[workspace,agent,room]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('synthetic-source',$1,$2,'Synthetic command requester')`,[room,owner]);
    await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,
      root_source_message_id,agent_depth,state,generation_id,lease_expires_at)
      VALUES($1,$2,$3,NULL,'socket-turn','input','system',$1,'synthetic-source',0,'claimed',$4,now()+interval '1 day')`,
      [identity.commandId,room,agent,identity.generationId]);
    const live=new LiveHub();daemon=new DaemonService(db,live);
    const presence={instanceId:'synthetic-activation',holdServerConnection:()=>()=>undefined,
      claimConnection:async(id:string,input:{connectionId:string})=>{
        epoch++;await db.query(`INSERT INTO agent_connections(agent_id,connection_id,epoch,instance_id) VALUES($1,$2,$3,'activation-test')
          ON CONFLICT(agent_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,epoch=EXCLUDED.epoch,released_at=NULL`,[id,input.connectionId,epoch]);return epoch;
      },releaseConnection:async()=>undefined} as unknown as ConnectionPresence;
    server=createBeelineServer({database:db,daemon,live,connectionPresence:presence,mediaMaximumBytes:1,
      auth:{authenticateDaemon:async()=>agent,authenticatePhone:async()=>null} as unknown as TokenAuth,
      phone:{canReadRooms:async(ids:readonly string[])=>new Set(ids)} as unknown as PhoneService});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));port=(server.address() as AddressInfo).port;
    socket=new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`,[MACHINE_SOCKET_PROTOCOL]);
    const reader=new HelperFrameReader();
    socket.on('message',raw=>{const value=reader.receive(JSON.parse(raw.toString()));if(value)frames.push(value);});
    await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    send({type:'register',token,activationContextV1:true});await next(frame=>frame.type==='registered');
  },60000);
  afterAll(async()=>{socket?.terminate();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));if(db)await closeDatabase();vi.unstubAllEnvs();});
  it('refuses generic HTTP before dispatch or application queries',async()=>{
    const query=vi.spyOn(db,'query'),execute=vi.spyOn(daemon,'execute');
    try{
      const response=await fetch(`http://127.0.0.1:${port}/v1/daemon/operations/readCommandActivation`,{method:'POST',
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({...identity,source:{connectionId:'unused',epoch:1}})});
      expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'activation_context_socket_required'});
      expect(execute).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
    }finally{query.mockRestore();execute.mockRestore();}
  });
  it('negotiates the actual connection actor and serves a complete validated command cut',async()=>{
    const registered=await next(frame=>frame.type==='registered');
    expect(registered.capabilities).toMatchObject({activationContextV1:true,activationConnectionEpoch:1});
    const source={connectionId:registered.capabilities.activationConnectionId,epoch:1};
    send({type:'activation-context',requestId:'complete-cut',input:{...identity,source}});
    const reply=await next(frame=>frame.type==='activation-context-result'&&frame.requestId==='complete-cut');
    expect(reply.result).toMatchObject({v:1,...identity,source,roster:{members:[{identityId:agent}]},grants:{grants:[]},repository:{resolution:'none'}});
    const read=vi.spyOn(daemon,'readCommandActivation');
    try{
      send({type:'activation-context',requestId:'malformed-cut',input:{...identity,source,arbitrary:true}});
      expect(await next(frame=>frame.requestId==='malformed-cut')).toMatchObject({error:'activation_context_refused'});expect(read).not.toHaveBeenCalled();
    }finally{read.mockRestore();}
  });
  it('pages every owed private command with exact microsecond cursor ordering',async()=>{
    await db.transaction(async tx=>{await tx.query('SET LOCAL statement_timeout=0');await tx.query(`INSERT INTO agent_commands
      (id,room_id,agent_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth,state,created_at)
      SELECT 'wake-page-'||n,$1,$2,'wake-turn-'||n,'input','system','wake-page-'||n,'synthetic-source',0,'pending','2026-11-04T00:00:00.123456Z'::timestamptz
      FROM generate_series(1,256)n`,[room,agent]);});
    const ids:string[]=[];let after:{createdAt:string;id:string}|undefined;
    for(;;){const page=await pendingMcpWakes(db,agent,after,31),rows=page.slice(0,30);ids.push(...rows.map(row=>row.id));
      const last=rows.at(-1);if(page.length<=30||!last)break;after={createdAt:last.deliveryCreatedAt,id:last.id};}
    expect(ids).toHaveLength(256);expect(new Set(ids).size).toBe(256);
    expect(await pendingMcpWakes(db,agent)).toHaveLength(30);
    await db.query(`DELETE FROM agent_commands WHERE id LIKE 'wake-page-%'`);
  });
  it('chunks actual >256 KiB command setup in a Workspace with 1,895 Rooms including archived corners',async()=>{
    const registered=await next(frame=>frame.type==='registered'),source={connectionId:registered.capabilities.activationConnectionId,epoch:1};
    await db.transaction(async tx=>{await tx.query('SET LOCAL statement_timeout=0');await tx.query(`INSERT INTO rooms(id,workspace_id,name,parent_id,archived_at)
      SELECT md5(n::text)::uuid,$1,'corner '||n,$2,CASE WHEN n%2=0 THEN now() ELSE NULL END FROM generate_series(1,1894)n`,[workspace,room]);});
    const instructions='rich setup '.repeat(30000);
    await db.query(`UPDATE agents SET soul=$2::jsonb WHERE agent_id=$1`,[agent,JSON.stringify({name:'Agent',instructions})]);
    send({type:'activation-context',requestId:'large-cut',input:{...identity,source}});
    const reply=await next(frame=>frame.type==='activation-context-result'&&frame.requestId==='large-cut');
    expect(reply.error).toBeUndefined();expect(reply.result.configuration.soul.instructions).toBe(instructions);
    expect((await db.query('SELECT count(*)::int count FROM rooms WHERE workspace_id=$1',[workspace])).rows[0]?.count).toBe(1895);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    await db.query(`UPDATE agents SET soul=NULL WHERE agent_id=$1`,[agent]);
  },30000);
  it('suppresses a queued result after a real committed source mutation and keeps default-off negotiation explicit',async()=>{
    const registered=await next(frame=>frame.type==='registered'),source={connectionId:registered.capabilities.activationConnectionId,epoch:1};
    const original=daemon.readCommandActivation.bind(daemon),read=vi.spyOn(daemon,'readCommandActivation').mockImplementationOnce(async(input,id)=>{
      const captured=await original(input,id);await db.query('UPDATE agents SET fast_mode=NOT fast_mode WHERE agent_id=$1',[agent]);return captured;
    });
    try{
      send({type:'activation-context',requestId:'revoked-cut',input:{...identity,source}});
      const reply=await next(frame=>frame.requestId==='revoked-cut');expect(reply).toMatchObject({error:'activation_context_refused'});expect(reply).not.toHaveProperty('result');
    }finally{read.mockRestore();}
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1','0');const before=frames.length;
    send({type:'register',token,activationContextV1:true});
    expect((await next(frame=>frames.indexOf(frame)>=before&&frame.type==='registered')).capabilities).not.toHaveProperty('activationContextV1');
  });
});
