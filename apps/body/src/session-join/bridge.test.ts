
import { afterEach as m40_afterEach, describe as m40_describe, expect as m40_expect, it as m40_it, vi as m40_vi } from 'vitest';

import { mkdtempSync as m40_mkdtempSync, readdirSync as m40_readdirSync, renameSync as m40_renameSync, rmSync as m40_rmSync } from 'node:fs';

import { tmpdir as m40_tmpdir } from 'node:os';

import { join as m40_join } from 'node:path';

import { Agent as m40_Agent } from 'undici';

import { acceptMemberDelivery as m40_acceptMemberDelivery, toolViaOutbox as m40_toolViaOutbox } from "./bridge.js";

import { memberStream as m40_memberStream } from "./beeline-api.js";

import { queueInboxOnce as m40_queueInboxOnce, readState as m40_readState, takeInbox as m40_takeInbox, updateState as m40_updateState, type JoinedSession as m40_JoinedSession } from "./store.js";
import { describe as mergedDescribe40 } from 'vitest';
mergedDescribe40("member-stream.test.ts", () => {


const folders:string[]=[];

const scratch=()=>{const dir=m40_mkdtempSync(m40_join(m40_tmpdir(),'beeline-stream-proof-'));folders.push(dir);return dir;};

const runner={node:'/synthetic/node',bundle:'/synthetic/beeline.js'};

const epoch='a'.repeat(32);

const joined:m40_JoinedSession={key:'codex:/synthetic/project',agent:'codex',cwd:'/synthetic/project',name:'synthetic',
  server:'https://synthetic.invalid',clientId:'client',refreshToken:'fixture-refresh',cursor:'0',deliveredWakes:[],joinedAt:''};

const delivery=(id='mention:one:0',cursor='1')=>({v:1,type:'delivery',deliveryId:id,
  mentions:[{id:'one',room_id:'room',text:'synthetic committed message'}],wakes:[],mentionCursor:cursor});

m40_afterEach(()=>{m40_vi.useRealTimers();m40_vi.restoreAllMocks();m40_vi.unstubAllGlobals();for(const dir of folders.splice(0))m40_rmSync(dir,{recursive:true,force:true});});


m40_describe('durable member delivery ownership',()=>{
  m40_it('recovers a crash between durable inbox and checkpoint without appending twice',async()=>{
    const dir=scratch();await m40_updateState(dir,state=>state.sessions.push({...joined}));
    // This is the durable first step before a process dies without state write.
    m40_expect(m40_queueInboxOnce(dir,joined.key,'mention:one:0','already persisted')).toBe(true);
    m40_expect(await m40_acceptMemberDelivery(dir,joined.key,runner,delivery())).toBe(0);
    m40_expect(m40_readState(dir).sessions[0]?.streamCursor).toBeUndefined();
    m40_expect(m40_takeInbox(dir,joined.key)).toBe('already persisted');
    m40_expect(await m40_acceptMemberDelivery(dir,joined.key,runner,delivery())).toBe(0);
    m40_expect(m40_takeInbox(dir,joined.key)).toBe('');
    await m40_acceptMemberDelivery(dir,joined.key,runner,{v:1,type:'checkpoint',cursor:{epoch,through:8},mentionCursor:'1'});
    m40_expect(m40_readState(dir).sessions[0]?.streamCursor).toEqual({epoch,through:8});
  });
  m40_it('keeps mention recovery at the last durable item and refuses backwards checkpoints',async()=>{
    const dir=scratch();await m40_updateState(dir,state=>state.sessions.push({...joined}));
    m40_expect(await m40_acceptMemberDelivery(dir,joined.key,runner,delivery())).toBe(1);
    m40_expect(m40_readState(dir).sessions[0]?.cursor).toBe('1');
    m40_expect(m40_takeInbox(dir,joined.key)).toContain('synthetic committed message');
    await m40_acceptMemberDelivery(dir,joined.key,runner,{v:1,type:'checkpoint',cursor:{epoch,through:8},mentionCursor:'2'});
    await m40_expect(m40_acceptMemberDelivery(dir,joined.key,runner,{v:1,type:'checkpoint',cursor:{epoch,through:7},mentionCursor:'1'})).rejects.toThrow('backwards');
    m40_expect(m40_readState(dir).sessions[0]).toMatchObject({cursor:'2',streamCursor:{epoch,through:8}});
  });
  m40_it('never permits direct fallback once a filesystem request was claimed',async()=>{
    m40_vi.useFakeTimers();const cwd=scratch();const waiting=m40_toolViaOutbox(cwd,'send_message',{text:'synthetic'},1000);
    const folder=m40_join(cwd,'.beeline','outbox');
    const request=m40_readdirSync(folder).find(name=>name.endsWith('.request.json'))!;
    m40_renameSync(m40_join(folder,request),m40_join(folder,request+'.taking'));
    await m40_vi.advanceTimersByTimeAsync(1000);
    m40_expect(await waiting).toEqual({ok:false,error:'Beeline tool result is awaiting confirmation'});
  });
  m40_it('permits direct fallback only after atomically withdrawing an unclaimed request',async()=>{
    m40_vi.useFakeTimers();const cwd=scratch();const waiting=m40_toolViaOutbox(cwd,'read_room',{},1000);
    await m40_vi.advanceTimersByTimeAsync(1000);
    m40_expect(await waiting).toBeUndefined();m40_expect(m40_readdirSync(m40_join(cwd,'.beeline','outbox'))).toEqual([]);
  });
});


m40_describe('existing authenticated stream transport',()=>{
  m40_it('stays idle for a day without an empty call, retaining header deadline but disabling body timeout',async()=>{
    m40_vi.useFakeTimers();let controller!:ReadableStreamDefaultController<Uint8Array>;
    const body=new ReadableStream<Uint8Array>({start(value){controller=value;}});
    const fetched=m40_vi.fn(async(_url:string,_init?:RequestInit)=>_init?.method==='POST'?Response.json({result:{capabilities:{memberStreamV1:true}}}):new Response(body,{headers:{'content-type':'application/x-ndjson'}}));m40_vi.stubGlobal('fetch',fetched);
    const stop=new AbortController(),opened=m40_vi.fn(),stream=m40_memberStream({...joined,streamCursor:{epoch,through:8}},'fixture-access',stop.signal,opened);
    const first=stream.next();await Promise.resolve();await Promise.resolve();
    controller.enqueue(new TextEncoder().encode(JSON.stringify({v:1,type:'checkpoint',cursor:{epoch,through:8},mentionCursor:'0'})+'\n'));
    m40_expect((await first).value).toMatchObject({type:'checkpoint'});
    const dispatcher=fetched.mock.calls[1]?.[1] as unknown as {dispatcher:m40_Agent};
    const dispatched=m40_vi.spyOn(m40_Agent.prototype,'dispatch').mockReturnValue(true);
    dispatcher.dispatcher.dispatch({origin:'https://synthetic.invalid',path:'/',method:'GET',bodyTimeout:300000,headersTimeout:1234},{} as never);
    m40_expect(dispatched).toHaveBeenCalledWith(m40_expect.objectContaining({bodyTimeout:0,headersTimeout:1234}),m40_expect.anything());
    await m40_vi.advanceTimersByTimeAsync(24*60*60*1000);
    m40_expect(fetched).toHaveBeenCalledTimes(2);m40_expect(opened).toHaveBeenCalledTimes(1);
    controller.close();m40_expect((await stream.next()).done).toBe(true);
  });
  m40_it('parks on an old server response without a fallback inbox poll',async()=>{
    const fetched=m40_vi.fn(async()=>new Response('',{status:404}));m40_vi.stubGlobal('fetch',fetched);
    await m40_expect(m40_memberStream(joined,'fixture-access',new AbortController().signal).next()).rejects.toThrow('unavailable');
    m40_expect(fetched).toHaveBeenCalledTimes(1);
  });
});
});

// Reproduction (SESSION-JOIN-RULES-1): a joined session never received Beeline's working rules. Join and the bridge
// only call tools/call, so the connector's MCP instructions never reach the model; Claude Code's in-session server
// answered initialize with no instructions; and the SessionStart hook printed only waiting mail.
import { spawn as m41_spawn } from 'node:child_process';

import { mkdirSync as m41_mkdirSync, mkdtempSync as m41_mkdtempSync, writeFileSync as m41_writeFileSync } from 'node:fs';

import { tmpdir as m41_tmpdir } from 'node:os';

import { join as m41_join, resolve as m41_resolve } from 'node:path';

import { describe as m41_describe, expect as m41_expect, it as m41_it } from 'vitest';

import { renderRules as m41_renderRules } from "./bridge.js";

import { runHook as m41_runHook } from "./hook.js";

import { queueInbox as m41_queueInbox, stateDir as m41_stateDir, updateState as m41_updateState, type JoinedSession as m41_JoinedSession } from "./store.js";
import { describe as mergedDescribe41 } from 'vitest';
mergedDescribe41("rules-delivery.test.ts", () => {


const runner = { node: '/node', bundle: '/b/usebeeline.mjs' };

const codex: m41_JoinedSession = { key: 'codex:/w', agent: 'codex', cwd: '/w', name: 'Codex', handle: 'codex_w', server: 'http://proof',
  clientId: 'c', refreshToken: 'r', cursor: '0', deliveredWakes: [], joinedAt: '', sessionId: 's1' };


m41_describe('SESSION-JOIN-RULES-1: a joined session receives the Beeline rules', () => {
  m41_it('renders the rules with the session\'s own commands and identity', () => {
    const text = m41_renderRules(codex, runner);
    m41_expect(text.startsWith('Beeline: you are @codex_w')).toBe(true);
    m41_expect(text).toContain("/node /b/usebeeline.mjs session tool <name> '<json arguments>' --as codex:/w");
    for (const rule of ['not a plain reply', 'Choose the terminal status', 'server adds its status prefix', 'one step up', 'Code work belongs in a corner',
      'approve_merge on the exact head SHA', 'post short progress there']) m41_expect(text).toContain(rule);
  });

  m41_it('puts the rules in front of the model at session start, ahead of waiting mail, and only then', async () => {
    const home = m41_mkdtempSync(m41_join(m41_tmpdir(), 'sj-rules-'));
    const dir = m41_stateDir({ HOME: home, XDG_STATE_HOME: home });
    await m41_updateState(dir, state => { state.sessions = [codex]; });
    m41_queueInbox(dir, codex.key, 'Beeline: order for you');
    const rules = (joined: m41_JoinedSession) => m41_renderRules(joined, runner);
    const start = JSON.parse(m41_runHook(dir, { agent: 'codex', event: 'session-start', payload: { session_id: 's1', cwd: '/w' }, rules }));
    const context = start.hookSpecificOutput.additionalContext as string;
    m41_expect(context.indexOf('Beeline: you are @codex_w')).toBe(0);
    m41_expect(context).toContain('Beeline: order for you');
    m41_expect(m41_runHook(dir, { agent: 'codex', event: 'user-prompt-submit', payload: { session_id: 's1', cwd: '/w' }, rules })).toBe('');
  });

  m41_it('serves the rules as Claude Code in-session MCP server instructions', async () => {
    const home = m41_mkdtempSync(m41_join(m41_tmpdir(), 'sj-claude-'));
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: home, CLAUDE_CONFIG_DIR: m41_join(home, '.claude') };
    // This test process stands in for the Claude Code session that starts the server.
    m41_mkdirSync(m41_join(env.CLAUDE_CONFIG_DIR, 'sessions'), { recursive: true });
    m41_writeFileSync(m41_join(env.CLAUDE_CONFIG_DIR, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'claude-s', cwd: '/repo' }));
    const claude: m41_JoinedSession = { ...codex, key: 'claude-code:/repo', agent: 'claude-code', cwd: '/repo', handle: 'claude_r', sessionId: 'claude-s', pid: process.pid };
    await m41_updateState(m41_stateDir(env), state => { state.sessions = [claude]; });
    const script = `import { runClaudeMcp } from ${JSON.stringify(m41_resolve('src/session-join/claude-mcp.ts'))};
      import { renderRules } from ${JSON.stringify(m41_resolve('src/session-join/bridge.ts'))};
      import { stateDir } from ${JSON.stringify(m41_resolve('src/session-join/store.ts'))};
      await runClaudeMcp(stateDir(process.env), process.env, joined => renderRules(joined, { node: 'node', bundle: '/b' }));`;
    const child = m41_spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no initialize answer: ${out}`)), 20_000);
      child.stdout.on('data', () => { if (out.includes('\n')) { clearTimeout(timer); done(); } });
    });
    child.stdin.end();
    const answer = JSON.parse(out.split('\n')[0]!) as { result: { instructions?: string } };
    m41_expect(answer.result.instructions).toContain('Beeline: you are @claude_r');
    m41_expect(answer.result.instructions).toContain('--as claude-code:/repo');
  }, 30_000);
});
});
