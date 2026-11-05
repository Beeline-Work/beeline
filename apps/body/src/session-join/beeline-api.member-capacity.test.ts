import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptMemberDelivery } from './bridge.js';
import { memberStream } from './beeline-api.js';
import { takeInbox, updateState, type JoinedSession } from './store.js';

const folders:string[]=[];
const scratch=()=>{const dir=mkdtempSync(join(tmpdir(),'beeline-stream-proof-'));folders.push(dir);return dir;};
const runner={node:'/synthetic/node',bundle:'/synthetic/beeline.js'};
const joined:JoinedSession={key:'codex:/synthetic/project',agent:'codex',cwd:'/synthetic/project',name:'synthetic',
  server:'https://synthetic.invalid',clientId:'client',refreshToken:'fixture-refresh',cursor:'0',deliveredWakes:[],joinedAt:''};
const delivery=(id='mention:one:0',cursor='1')=>({v:1,type:'delivery',deliveryId:id,
  mentions:[{id:'one',room_id:'room',text:'synthetic committed message'}],wakes:[],mentionCursor:cursor});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();for(const dir of folders.splice(0))rmSync(dir,{recursive:true,force:true});});

describe('large member delivery',()=>{
  it('accepts a large valid delivery through the NDJSON parser and durable inbox owner',async()=>{
    const text='large valid mention '.repeat(30_000),frame={...delivery(),mentions:Array.from({length:31},(_,index)=>({id:'large-'+index,room_id:'room',text:index===0?text:'ordinary mention'}))};
    const encoded=new TextEncoder().encode(JSON.stringify(frame)+'\n');
    const body=new ReadableStream<Uint8Array>({start(controller){for(let offset=0;offset<encoded.length;offset+=8192)controller.enqueue(encoded.slice(offset,offset+8192));controller.close();}});
    vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='POST'?Response.json({result:{capabilities:{memberStreamV1:true}}}):new Response(body,{headers:{'content-type':'application/x-ndjson'}})));
    const stream=memberStream(joined,'fixture-access',new AbortController().signal),received=(await stream.next()).value;
    const dir=scratch();await updateState(dir,state=>state.sessions.push({...joined}));
    expect(await acceptMemberDelivery(dir,joined.key,runner,received)).toBe(31);expect(takeInbox(dir,joined.key)).toContain(text);expect((await stream.next()).done).toBe(true);
  });

});
