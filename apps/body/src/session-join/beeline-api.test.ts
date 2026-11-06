
import { afterEach as move5_afterEach,describe as move5_describe,expect as move5_expect,it as move5_it,vi as move5_vi } from 'vitest';

import { finishSignIn as move5_finishSignIn,SignInPendingError as move5_SignInPendingError,type SignIn as move5_SignIn } from "./beeline-api.js";

import { Agent as move5_Agent } from 'undici';
import { describe as movedDescribe5 } from 'vitest';
movedDescribe5("oauth-completion.test.ts", () => {

const signIn=():move5_SignIn=>({url:'https://synthetic.invalid/mcp/oauth/authorize',state:'s'.repeat(43),verifier:'v'.repeat(43)});

const tokens={access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600};

move5_afterEach(()=>{move5_vi.useRealTimers();move5_vi.restoreAllMocks();move5_vi.unstubAllGlobals();});

move5_describe('one correlated held OAuth completion',()=>{
  move5_it('keeps one request for10min and persists code/uncertainty/result before advancing',async()=>{
    move5_vi.useFakeTimers();let finish!:(response:Response)=>void;const persisted:move5_SignIn[]=[],state=signIn();
    const fetcher=move5_vi.fn(async(url:string,init:RequestInit)=>{
      if(url.endsWith('/handoff')){move5_expect(JSON.parse(String(init.body))).toMatchObject({state:state.state,completionV1:true,waitMs:600_000});
        return new Promise<Response>(resolve=>{finish=resolve;});}
      move5_expect(persisted.at(-1)).toMatchObject({code:'synthetic-code',exchangeStarted:true});return Response.json(tokens);
    });move5_vi.stubGlobal('fetch',fetcher);
    const result=move5_finishSignIn('https://synthetic.invalid','client',state,Date.now()+600_000,value=>{persisted.push(structuredClone(value));});
    await move5_vi.advanceTimersByTimeAsync(599_999);move5_expect(fetcher).toHaveBeenCalledOnce();
    const request=fetcher.mock.calls[0]![1] as RequestInit&{dispatcher:move5_Agent};
    const dispatch=move5_vi.spyOn(move5_Agent.prototype,'dispatch').mockReturnValue(true);
    request.dispatcher.dispatch({origin:'https://synthetic.invalid',path:'/mcp/oauth/handoff',method:'POST',headersTimeout:1234,bodyTimeout:300000},{} as never);
    move5_expect(dispatch).toHaveBeenCalledWith(move5_expect.objectContaining({bodyTimeout:0,headersTimeout:1234}),move5_expect.anything());dispatch.mockRestore();
    finish(Response.json({code:'synthetic-code'}));move5_expect(await result).toEqual(tokens);
    move5_expect(fetcher).toHaveBeenCalledTimes(2);move5_expect(persisted.at(-1)).toMatchObject({tokens,tokensAt:move5_expect.any(Number)});
    const recovered=structuredClone(state);await move5_finishSignIn('https://synthetic.invalid','client',recovered,Date.now()+1);
    move5_expect(fetcher).toHaveBeenCalledTimes(2);
  });
  move5_it('keeps old-server pending and lost token results UNKNOWN without repeating an observation/exchange',async()=>{
    const fetcher=move5_vi.fn(async()=>Response.json({error:'authorization_pending'},{status:400}));move5_vi.stubGlobal('fetch',fetcher);
    await move5_expect(move5_finishSignIn('https://synthetic.invalid','client',signIn())).rejects.toBeInstanceOf(move5_SignInPendingError);move5_expect(fetcher).toHaveBeenCalledOnce();
    const state=signIn();fetcher.mockResolvedValueOnce(Response.json({code:'synthetic-code'})).mockRejectedValueOnce(new Error('response lost'));
    await move5_expect(move5_finishSignIn('https://synthetic.invalid','client',state)).rejects.toBeInstanceOf(move5_SignInPendingError);
    move5_expect(state.exchangeStarted).toBe(true);const sent=fetcher.mock.calls.length;
    await move5_expect(move5_finishSignIn('https://synthetic.invalid','client',structuredClone(state))).rejects.toBeInstanceOf(move5_SignInPendingError);move5_expect(fetcher).toHaveBeenCalledTimes(sent);
  });
  move5_it('sends no token exchange after local persistence failure',async()=>{
    const fetcher=move5_vi.fn(async()=>Response.json({code:'synthetic-code'}));move5_vi.stubGlobal('fetch',fetcher);
    await move5_expect(move5_finishSignIn('https://synthetic.invalid','client',signIn(),Date.now()+600_000,()=>{throw new Error('Synthetic storage failure');})).rejects.toThrow('storage failure');
    move5_expect(fetcher).toHaveBeenCalledOnce();
  });
  move5_it('cannot select the no-idle-timeout adapter for a different path or unscoped ceremony',async()=>{
    const fetcher=move5_vi.fn(async()=>Response.json({}));move5_vi.stubGlobal('fetch',fetcher);
    await move5_expect(move5_finishSignIn('https://synthetic.invalid/arbitrary','client',signIn())).rejects.toBeInstanceOf(move5_SignInPendingError);
    await move5_expect(move5_finishSignIn('https://synthetic.invalid','client',{...signIn(),state:'unscoped'})).rejects.toBeInstanceOf(move5_SignInPendingError);
    move5_expect(fetcher).not.toHaveBeenCalled();
  });
});
});

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
