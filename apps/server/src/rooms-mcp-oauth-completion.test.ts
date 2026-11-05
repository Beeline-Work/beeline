import { createServer,request as httpRequest,type ClientRequest,type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll,afterEach,beforeAll,describe,expect,it,vi } from 'vitest';
import type { TokenAuth } from './auth.js';
import { RoomsMcpOAuth } from './rooms-mcp-oauth.js';
import { ROOMS_MCP_SCHEMA } from './rooms-mcp-schema.js';
import { COMMAND_COMPLETION_CHANNEL,notifyCommandCompletion } from './command-completion.js';
import { migratedDatabase,type PgliteDatabase } from "../../../tests/helpers/server.js";
import type { SqlDatabase } from './database.js';
describe('actual committed MCP OAuth held completion',()=>{
  let db:PgliteDatabase,server:Server,origin:string,ready=true,release:()=>Promise<void>;
  const reads:string[]=[],payloads:string[]=[],requests:ClientRequest[]=[];
  beforeAll(async()=>{
    db=await migratedDatabase();await db.query(ROOMS_MCP_SCHEMA);
    release=await db.client.listen(COMMAND_COMPLETION_CHANNEL,payload=>{payloads.push(payload);notifyCommandCompletion(payload);});
    const observed:SqlDatabase={transaction:work=>db.transaction(work),query:(sql,values)=>{
      if(sql.startsWith('SELECT code,error FROM rooms_mcp_handoffs'))reads.push(sql);return db.query(sql,values);
    }};
    const oauth=new RoomsMcpOAuth(observed,'http://synthetic.invalid',{} as TokenAuth,undefined,()=>ready);
    server=createServer((request,response)=>{void oauth.handle(request,response,new URL(request.url!,'http://synthetic.invalid')).catch(()=>{response.destroy();});});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  },60000);
  afterEach(()=>{for(const request of requests.splice(0))request.destroy();vi.useRealTimers();ready=true;});
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await release();await db.close();});
  const post=(input:Record<string,unknown>)=>{
    let connected!:()=>void,resolve!:(value:{status:number;body:Record<string,unknown>})=>void,reject!:(error:Error)=>void;
    const headers=new Promise<void>(done=>{connected=done;}),done=new Promise<{status:number;body:Record<string,unknown>}>((yes,no)=>{resolve=yes;reject=no;});
    // Node's finite test client has no SDK idle-body timer hiding this proof.
    const request=httpRequest(origin+'/mcp/oauth/handoff',{method:'POST',headers:{'content-type':'application/json'}},response=>{
      connected();let text='';response.on('data',chunk=>{text+=chunk;});response.on('end',()=>resolve({status:response.statusCode!,body:JSON.parse(text)}));response.on('error',reject);
    });request.on('error',reject);request.end(JSON.stringify(input));requests.push(request);return {request,headers,done};
  };
  it('keeps one initial read through a ten-minute deadline and reads nothing when completion feed is unavailable',async()=>{
    vi.useFakeTimers();const before=reads.length,waiting=post({state:'a'.repeat(43),completionV1:true,waitMs:600_000});
    await waiting.headers;await vi.waitFor(()=>expect(reads).toHaveLength(before+1));
    await vi.advanceTimersByTimeAsync(599_999);expect(reads).toHaveLength(before+1);
    await vi.advanceTimersByTimeAsync(1);expect(await waiting.done).toEqual({status:200,body:{error:'authorization_pending'}});expect(reads).toHaveLength(before+1);
    ready=false;const unavailable=await post({state:'b'.repeat(43),completionV1:true,waitMs:1}).done;
    expect(unavailable.status).toBe(503);expect(reads).toHaveLength(before+1);
  });
  it('wakes only the correlated state from a real commit and replays an opt-in receipt while legacy consumption stays one-use',async()=>{
    const state='c'.repeat(43),before=reads.length,waiting=post({state,completionV1:true,waitMs:600_000});await waiting.headers;
    await vi.waitFor(()=>expect(reads).toHaveLength(before+1));
    await fetch(origin+'/mcp/oauth/handoff?state='+'d'.repeat(43)+'&code=wrong');expect(reads).toHaveLength(before+1);
    await fetch(origin+'/mcp/oauth/handoff?state='+state+'&code=synthetic-code');expect(await waiting.done).toEqual({status:200,body:{code:'synthetic-code'}});
    expect(await post({state,completionV1:true,waitMs:1000}).done).toEqual({status:200,body:{code:'synthetic-code'}});
    expect(await post({state}).done).toEqual({status:200,body:{code:'synthetic-code'}});
    expect(await post({state}).done).toEqual({status:400,body:{error:'authorization_pending'}});
    const hints=payloads.map(payload=>JSON.parse(payload)).filter(key=>key.operation==='mcp-handoff');
    expect(hints).toHaveLength(2);expect(JSON.stringify(hints)).not.toContain(state);expect(JSON.stringify(hints)).not.toContain('synthetic-code');
  });
  it('bounds concurrent waits for one state and releases admission on actual cancellation',async()=>{
    const state='e'.repeat(43),first=post({state,completionV1:true,waitMs:600_000}),second=post({state,completionV1:true,waitMs:600_000});
    // Attach rejection consumers before destroying either actual client.
    const firstResult=first.done.catch(()=>undefined),secondResult=second.done.catch(()=>undefined);
    await Promise.all([first.headers,second.headers]);expect((await post({state,completionV1:true,waitMs:600_000}).done).status).toBe(429);
    first.request.destroy(new Error('Synthetic client cancellation'));second.request.destroy(new Error('Synthetic client cancellation'));
    await Promise.all([firstResult,secondResult]);
    await vi.waitFor(async()=>{expect((await post({state,completionV1:true,waitMs:1}).done).status).toBe(200);});
  });
});
