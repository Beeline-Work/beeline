import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'undici';
import { acceptMemberDelivery, toolViaOutbox } from './bridge.js';
import { memberStream } from './beeline-api.js';
import { queueInboxOnce, readState, takeInbox, updateState, type JoinedSession } from './store.js';

const folders:string[]=[];
const scratch=()=>{const dir=mkdtempSync(join(tmpdir(),'beeline-stream-proof-'));folders.push(dir);return dir;};
const runner={node:'/synthetic/node',bundle:'/synthetic/beeline.js'};
const epoch='a'.repeat(32);
const joined:JoinedSession={key:'codex:/synthetic/project',agent:'codex',cwd:'/synthetic/project',name:'synthetic',
  server:'https://synthetic.invalid',clientId:'client',refreshToken:'fixture-refresh',cursor:'0',deliveredWakes:[],joinedAt:''};
const delivery=(id='mention:one:0',cursor='1')=>({v:1,type:'delivery',deliveryId:id,
  mentions:[{id:'one',room_id:'room',text:'synthetic committed message'}],wakes:[],mentionCursor:cursor});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();for(const dir of folders.splice(0))rmSync(dir,{recursive:true,force:true});});

describe('durable member delivery ownership',()=>{
  it('recovers a crash between durable inbox and checkpoint without appending twice',async()=>{
    const dir=scratch();await updateState(dir,state=>state.sessions.push({...joined}));
    // This is the durable first step before a process dies without state write.
    expect(queueInboxOnce(dir,joined.key,'mention:one:0','already persisted')).toBe(true);
    expect(await acceptMemberDelivery(dir,joined.key,runner,delivery())).toBe(0);
    expect(readState(dir).sessions[0]?.streamCursor).toBeUndefined();
    expect(takeInbox(dir,joined.key)).toBe('already persisted');
    expect(await acceptMemberDelivery(dir,joined.key,runner,delivery())).toBe(0);
    expect(takeInbox(dir,joined.key)).toBe('');
    await acceptMemberDelivery(dir,joined.key,runner,{v:1,type:'checkpoint',cursor:{epoch,through:8},mentionCursor:'1'});
    expect(readState(dir).sessions[0]?.streamCursor).toEqual({epoch,through:8});
  });
  it('keeps mention recovery at the last durable item and refuses backwards checkpoints',async()=>{
    const dir=scratch();await updateState(dir,state=>state.sessions.push({...joined}));
    expect(await acceptMemberDelivery(dir,joined.key,runner,delivery())).toBe(1);
    expect(readState(dir).sessions[0]?.cursor).toBe('1');
    expect(takeInbox(dir,joined.key)).toContain('synthetic committed message');
    await acceptMemberDelivery(dir,joined.key,runner,{v:1,type:'checkpoint',cursor:{epoch,through:8},mentionCursor:'2'});
    await expect(acceptMemberDelivery(dir,joined.key,runner,{v:1,type:'checkpoint',cursor:{epoch,through:7},mentionCursor:'1'})).rejects.toThrow('backwards');
    expect(readState(dir).sessions[0]).toMatchObject({cursor:'2',streamCursor:{epoch,through:8}});
  });
  it('never permits direct fallback once a filesystem request was claimed',async()=>{
    vi.useFakeTimers();const cwd=scratch();const waiting=toolViaOutbox(cwd,'send_message',{text:'synthetic'},1000);
    const folder=join(cwd,'.beeline','outbox');
    const request=readdirSync(folder).find(name=>name.endsWith('.request.json'))!;
    renameSync(join(folder,request),join(folder,request+'.taking'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toEqual({ok:false,error:'Beeline tool result is awaiting confirmation'});
  });
  it('permits direct fallback only after atomically withdrawing an unclaimed request',async()=>{
    vi.useFakeTimers();const cwd=scratch();const waiting=toolViaOutbox(cwd,'read_room',{},1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toBeUndefined();expect(readdirSync(join(cwd,'.beeline','outbox'))).toEqual([]);
  });
});

describe('existing authenticated stream transport',()=>{
  it('stays idle for a day without an empty call, retaining header deadline but disabling body timeout',async()=>{
    vi.useFakeTimers();let controller!:ReadableStreamDefaultController<Uint8Array>;
    const body=new ReadableStream<Uint8Array>({start(value){controller=value;}});
    const fetched=vi.fn(async(_url:string,_init?:RequestInit)=>_init?.method==='POST'?Response.json({result:{capabilities:{memberStreamV1:true}}}):new Response(body,{headers:{'content-type':'application/x-ndjson'}}));vi.stubGlobal('fetch',fetched);
    const stop=new AbortController(),opened=vi.fn(),stream=memberStream({...joined,streamCursor:{epoch,through:8}},'fixture-access',stop.signal,opened);
    const first=stream.next();await Promise.resolve();await Promise.resolve();
    controller.enqueue(new TextEncoder().encode(JSON.stringify({v:1,type:'checkpoint',cursor:{epoch,through:8},mentionCursor:'0'})+'\n'));
    expect((await first).value).toMatchObject({type:'checkpoint'});
    const dispatcher=fetched.mock.calls[1]?.[1] as unknown as {dispatcher:Agent};
    const dispatched=vi.spyOn(Agent.prototype,'dispatch').mockReturnValue(true);
    dispatcher.dispatcher.dispatch({origin:'https://synthetic.invalid',path:'/',method:'GET',bodyTimeout:300000,headersTimeout:1234},{} as never);
    expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({bodyTimeout:0,headersTimeout:1234}),expect.anything());
    await vi.advanceTimersByTimeAsync(24*60*60*1000);
    expect(fetched).toHaveBeenCalledTimes(2);expect(opened).toHaveBeenCalledTimes(1);
    controller.close();expect((await stream.next()).done).toBe(true);
  });
  it('accepts a large valid delivery through the NDJSON parser and durable inbox owner',async()=>{
    const text='large valid mention '.repeat(30_000),frame={...delivery(),mentions:Array.from({length:31},(_,index)=>({id:'large-'+index,room_id:'room',text:index===0?text:'ordinary mention'}))};
    const encoded=new TextEncoder().encode(JSON.stringify(frame)+'\n');
    const body=new ReadableStream<Uint8Array>({start(controller){for(let offset=0;offset<encoded.length;offset+=8192)controller.enqueue(encoded.slice(offset,offset+8192));controller.close();}});
    vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({result:{capabilities:{memberStreamV1:true}}}):new Response(body,{headers:{'content-type':'application/x-ndjson'}})));
    const stream=memberStream(joined,'fixture-access',new AbortController().signal),received=(await stream.next()).value;
    const dir=scratch();await updateState(dir,state=>state.sessions.push({...joined}));
    expect(await acceptMemberDelivery(dir,joined.key,runner,received)).toBe(31);expect(takeInbox(dir,joined.key)).toContain(text);expect((await stream.next()).done).toBe(true);
  });
  it('parks on an old server response without a fallback inbox poll',async()=>{
    const fetched=vi.fn(async()=>new Response('',{status:404}));vi.stubGlobal('fetch',fetched);
    await expect(memberStream(joined,'fixture-access',new AbortController().signal).next()).rejects.toThrow('unavailable');
    expect(fetched).toHaveBeenCalledTimes(1);
  });
});
