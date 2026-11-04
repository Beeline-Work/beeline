import { createHash } from 'node:crypto';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { runSessionCommand } from './command.js';
import { stateDir,readState } from './store.js';
const storage=vi.hoisted(()=>({target:'',failRename:false,renamed:0,synced:0}));
vi.mock('node:fs',async original=>{
  const actual=await original<typeof import('node:fs')>();return {...actual,
    fsyncSync:(fd:number)=>{storage.synced++;return actual.fsyncSync(fd);},
    renameSync:(from:import('node:fs').PathLike,to:import('node:fs').PathLike)=>{
      if(String(to)===storage.target){if(storage.failRename)throw new Error('Synthetic atomic rename failure');storage.renamed++;}
      return actual.renameSync(from,to);
    },
  };
});
const roots:string[]=[],tokens={access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();storage.failRename=false;storage.target='';storage.renamed=0;storage.synced=0;
  for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'beeline-join-progress-'));roots.push(root);const bundle=join(root,'noop.mjs');writeFileSync(bundle,'');
  const env={HOME:root,XDG_STATE_HOME:root,PATH:'',BEELINE_SESSION_AGENT:'hermes',BEELINE_SESSION_BUNDLE:bundle,BEELINE_SERVER_URL:'https://synthetic.invalid'};
  const dir=stateDir(env),folder=join(dir,'pending');mkdirSync(folder,{recursive:true,mode:0o700});
  const state='s'.repeat(43),file=join(folder,createHash('sha256').update(state).digest('hex').slice(0,24)+'.json');
  const pending={server:'https://synthetic.invalid',clientId:'synthetic-client',agent:'hermes',cwd:process.cwd(),name:'synthetic-member',startedAt:Date.now(),
    signIn:{state,verifier:'v'.repeat(43),url:'https://synthetic.invalid/mcp/oauth/authorize?state='+state}};
  writeFileSync(file,JSON.stringify(pending),{mode:0o600});storage.target=file;
  return {env,dir,folder,file,pending,finish:()=>runSessionCommand(['session','finish-join',file],env)};
}
function toolResponse(input:Record<string,any>):Response{
  const name=input.params.name,data=name==='list_mentions'?{mentions:[],wakes:[],nextCursor:'0'}:
    name==='list_rooms'?{rooms:[],you:{id:'synthetic-member',name:'synthetic-member',handle:'synthetic-member'}}:{updated:true};
  return Response.json({jsonrpc:'2.0',id:input.id,result:{content:[{type:'text',text:JSON.stringify({data})}]}});
}
describe('actual private pending sign-in progression',()=>{
  it('atomically persists code/exchange uncertainty before token and known result before bootstrap',async()=>{
    const {file,folder,dir,finish}=fixture();
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      if(url.endsWith('/handoff'))return Response.json({code:'synthetic-code'});
      const held=JSON.parse(readFileSync(file,'utf8'));
      expect(statSync(file).mode&0o777).toBe(0o600);expect(readdirSync(folder).some(name=>name.endsWith('.tmp'))).toBe(false);
      if(url.endsWith('/token')){
        expect(held.signIn).toMatchObject({code:'synthetic-code',exchangeStarted:true});expect(storage.renamed).toBe(2);expect(storage.synced).toBeGreaterThanOrEqual(2);
        return Response.json(tokens);
      }
      expect(held.signIn).toMatchObject({tokens,tokensAt:expect.any(Number)});expect(storage.renamed).toBe(3);
      return toolResponse(JSON.parse(String(init.body)));
    });vi.stubGlobal('fetch',fetcher);await finish();
    expect(existsSync(file)).toBe(false);expect(readState(dir).sessions).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/handoff'))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/token'))).toHaveLength(1);
  });
  it('joins two actual finishers under the existing kernel owner with one held request/exchange',async()=>{
    const {finish}=fixture();let resolve!:(response:Response)=>void,started!:()=>void;
    const entered=new Promise<void>(done=>{started=done;});
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      if(url.endsWith('/handoff')){started();return new Promise<Response>(done=>{resolve=done;});}
      return url.endsWith('/token')?Response.json(tokens):toolResponse(JSON.parse(String(init.body)));
    });vi.stubGlobal('fetch',fetcher);
    const first=finish();await entered;await finish();expect(fetcher).toHaveBeenCalledOnce();
    resolve(Response.json({code:'synthetic-code'}));await first;
    expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/token'))).toHaveLength(1);
  });
  it('keeps the previous complete file on rename failure and sends no token until an explicit resume',async()=>{
    const {file,folder,pending,finish}=fixture();storage.failRename=true;
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>url.endsWith('/handoff')?Response.json({code:'synthetic-code'}):
      url.endsWith('/token')?Response.json(tokens):toolResponse(JSON.parse(String(init.body))));vi.stubGlobal('fetch',fetcher);
    await expect(finish()).rejects.toThrow('atomic rename failure');expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(file,'utf8'))).toEqual(pending);expect(readdirSync(folder)).toEqual([file.split('/').at(-1)]);
    storage.failRename=false;await finish();expect(existsSync(file)).toBe(false);
    expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/token'))).toHaveLength(1);
  });
  it('retains UNKNOWN exchange identity without resend and reuses the same client only on a new explicit join',async()=>{
    const {file,folder,pending,env,finish}=fixture();
    const fetcher=vi.fn(async(url:string)=>{
      if(url.endsWith('/handoff'))return Response.json({code:'synthetic-code'});
      if(url.endsWith('/token'))throw new Error('Synthetic token response lost');
      throw new Error('No other request admitted');
    });vi.stubGlobal('fetch',fetcher);
    await expect(finish()).rejects.toThrow('unknown');expect(JSON.parse(readFileSync(file,'utf8')).signIn.exchangeStarted).toBe(true);
    await expect(finish()).rejects.toThrow('unknown');expect(fetcher).toHaveBeenCalledTimes(2);
    const log=vi.spyOn(console,'log').mockImplementation(()=>{});await runSessionCommand(['join'],env);log.mockRestore();
    expect(fetcher).toHaveBeenCalledTimes(2);const files=readdirSync(folder);expect(files).toHaveLength(1);
    const next=JSON.parse(readFileSync(join(folder,files[0]!),'utf8'));expect(next.clientId).toBe(pending.clientId);
    expect(next.signIn.state).not.toBe(pending.signIn.state);expect(next.signIn.exchangeStarted).toBeUndefined();
  });
  it('recovers known persisted token results after interrupted bootstrap without another OAuth request',async()=>{
    const {file,dir,finish}=fixture();let failBootstrap=true;
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      if(url.endsWith('/handoff'))return Response.json({code:'synthetic-code'});
      if(url.endsWith('/token'))return Response.json(tokens);
      if(failBootstrap){failBootstrap=false;throw new Error('Synthetic bootstrap interrupted');}
      return toolResponse(JSON.parse(String(init.body)));
    });vi.stubGlobal('fetch',fetcher);
    await expect(finish()).rejects.toThrow('bootstrap interrupted');expect(JSON.parse(readFileSync(file,'utf8')).signIn.tokens).toEqual(tokens);
    await finish();expect(existsSync(file)).toBe(false);expect(readState(dir).sessions).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/handoff')||url.endsWith('/token'))).toHaveLength(2);
  });
  it('keeps expired known tokens parked on cold finish and starts new consent with the same client only on explicit join',async()=>{
    const {file,folder,pending,env,finish}=fixture();
    writeFileSync(file,JSON.stringify({...pending,signIn:{...pending.signIn,exchangeStarted:true,tokens,tokensAt:Date.now()-3_700_000}}),{mode:0o600});
    const fetcher=vi.fn(()=>{throw new Error('Cold OAuth must not run');});vi.stubGlobal('fetch',fetcher);
    await expect(finish()).rejects.toThrow('new explicit authorization');expect(fetcher).not.toHaveBeenCalled();
    const log=vi.spyOn(console,'log').mockImplementation(()=>{});await runSessionCommand(['join'],env);log.mockRestore();
    expect(fetcher).not.toHaveBeenCalled();const files=readdirSync(folder);expect(files).toHaveLength(1);
    const next=JSON.parse(readFileSync(join(folder,files[0]!),'utf8'));expect(next.clientId).toBe(pending.clientId);
    expect(next.signIn.state).not.toBe(pending.signIn.state);expect(next.signIn.tokens).toBeUndefined();expect(next.signIn.exchangeStarted).toBeUndefined();
  });
});
