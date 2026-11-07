import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { AcpClient } from './acp.js';
import { startAgentProcess, stopAgentProcess } from './agent-process.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';
import { callAgentTool } from './read-only-mcp.js';
import { sessionToolScopeMeta } from './harness-tool-scope.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const harness = String.raw`
const input = require('node:readline').createInterface({input: process.stdin});
let pending;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
input.on('line', line => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') send({jsonrpc:'2.0', id:r.id, result:{protocolVersion:1, agentCapabilities:{}}});
  if (r.method === 'session/new') send({jsonrpc:'2.0', id:r.id, result:{sessionId:'claude'}});
  if (r.method === 'session/prompt') {
    pending = r;
    send({jsonrpc:'2.0', method:'session/update', params:{sessionId:'claude', update:{sessionUpdate:'tool_call', toolCallId:'wake', title:'mcp__beeline-agent__wake', status:'in_progress', rawInput:{action:'create',trigger:'schedule'}}}});
    process.stderr.write('prompt-ready');
  }
  if (r.method === 'fixture/tool-completed') send({jsonrpc:'2.0', method:'session/update', params:{sessionId:'claude', update:{sessionUpdate:'tool_call_update', toolCallId:'wake', status:'completed', content:[{type:'content',content:{type:'text',text:r.params.text}}]}}});
  if (r.method === 'fixture/complete') {
    send({jsonrpc:'2.0', method:'session/update', params:{sessionId:'claude', update:{sessionUpdate:'agent_message_chunk', content:{type:'text',text:'Finished.'}}}});
    send({jsonrpc:'2.0', id:pending.id, result:{stopReason:'end_turn'}});
  }
});
`;

function command(id: string): AgentCommand {
  return { id, roomId: 'room', agentId: 'ruby', sourceMessageId: id, turnRequestId: id,
    action: 'input', reason: 'agent_tag', rootCommandId: id, rootSourceMessageId: id,
    agentDepth: 0, source: { id, authorId: 'another-agent', body: id, createdAt: 1, attachments: [] } };
}

it('finishes after wake(create schedule), then starts the queued wake while the Claude harness stays alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-claude-completion-'));
  const controller = new AbortController();
  const context = new CommandExecutionContext(root);
  const client = new AcpClient({ agentCommand: process.execPath, agentArgs: ['-e', harness],
    agentLabel: 'claude-agent-acp', agentEnv: {BEELINE_TURN_CONTEXT_FILE: context.path}, resourceScope: 'none' });
  const queue = [command('original')];
  const completed: string[] = [];
  const errors: unknown[] = [];
  let notify!: (commands?: readonly AgentCommand[]) => void;
  vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://fixture.invalid');
  vi.stubEnv('BEELINE_DAEMON_TOKEN', 'fixture-only');
  vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room');
  vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
  vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context.path);
  const schedule = vi.fn(async (url: URL) => {
    expect(url.pathname).toBe('/v1/daemon/operations/createAgentSchedule');
    queue.push(command('new-wake'));
    notify([queue[0]!]);
    return Response.json({scheduleId:'self-schedule'});
  });
  vi.stubGlobal('fetch', schedule);
  const execute = vi.fn(async (name: string, input: {commandId?: string}) => {
    if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [...queue] };
    if (name === 'claimAgentTurn') {
      expect(queue[0]?.id).toBe(input.commandId);
      return { commands: [queue.shift()!] };
    }
    if (name === 'releaseAgentTurn') return { commands: [...queue] };
    return {};
  });
  let running: Promise<void> | undefined;
  try {
    await startAgentProcess(client);
    const { sessionId } = await client.sessionNew({ cwd: root });
    const firstReady = once(client, 'stderr');
    running = runServerCommandIntake({ api: {execute} as unknown as DaemonApiClient,
      roomId: 'room', agentId: 'ruby', context,
      signal: controller.signal, stop: vi.fn(), onError: error => errors.push(error),
      onWake: wake => { if (wake) notify = wake; },
      run: async item => {
        const result = await client.sessionPrompt(sessionId, item.source.body);
        expect(result.stopReason).toBe('end_turn');
        expect(result.agentText).toBe('Finished.');
        completed.push(item.id);
        if (completed.length === 2) controller.abort();
      } });
    await firstReady;
    const pid = client.processPid();
    const toolResult = await callAgentTool('wake', {action:'create', trigger:'schedule',
      title:'Ledger write retry', prompt:'Retry the ledger write', cadence:{kind:'interval', everyMinutes:30}}, 'wake');
    expect(toolResult).toContain('Schedule self-schedule created: every 30 minutes');
    expect(schedule).toHaveBeenCalledOnce();
    client.notify('fixture/tool-completed', {text:toolResult});
    expect(execute.mock.calls.filter(([name]) => name === 'claimAgentTurn')).toHaveLength(1);
    const secondReady = once(client, 'stderr');
    client.notify('fixture/complete', {});
    await secondReady;
    expect(completed).toEqual(['original']);
    expect(client.processPid()).toBe(pid);
    expect(client.isAlive).toBe(true);
    client.notify('fixture/complete', {});
    await running;
    expect(completed).toEqual(['original', 'new-wake']);
    expect(errors).toEqual([]);
  } finally {
    controller.abort();
    await stopAgentProcess(client);
    await running;
    await rm(root, {recursive:true, force:true});
  }
});

it('logs native end_turn and result separately from the ACP response without recording content', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const client = new AcpClient({agentCommand:'claude-agent-acp', agentEnv:{}});
  const native = (message: Record<string, unknown>) => client.handleMessage({jsonrpc:'2.0',
    method:'_claude/sdkMessage', params:{sessionId:'session', message}});
  native({type:'assistant', parent_tool_use_id:null, message:{stop_reason:'tool_use', content:'private input'}});
  expect(info).not.toHaveBeenCalled();
  native({type:'assistant', parent_tool_use_id:null, message:{stop_reason:'end_turn', content:'private answer'}});
  native({type:'result', stop_reason:'end_turn', subtype:'success', is_error:false, result:'private answer'});
  const resolve = vi.fn();
  client.pending.set(7, {resolve, reject:vi.fn(), sessionId:'session'});
  client.handleMessage({jsonrpc:'2.0', id:7, result:{stopReason:'end_turn'}});
  const events = info.mock.calls.map(([, data]) => JSON.parse(String(data)));
  expect(events.map(event => event.event)).toEqual(['claude-assistant','claude-result','acp-result']);
  expect(events.every(event => event.sessionId === 'session' && event.stopReason === 'end_turn')).toBe(true);
  expect(JSON.stringify(info.mock.calls)).not.toContain('private');
  expect(resolve).toHaveBeenCalledWith({stopReason:'end_turn'});
  expect(sessionToolScopeMeta('claude-agent-acp')).toMatchObject({claudeCode:{
    emitRawSDKMessages:[{type:'assistant'},{type:'result'}],
  }});
});

// Run against an installed adapter without a real account or model:
// BEELINE_TEST_CLAUDE_ACP=/absolute/path/to/claude-agent-acp vitest run src/claude-turn-completion.test.ts --maxWorkers=2 --minWorkers=1
it.skipIf(!process.env.BEELINE_TEST_CLAUDE_ACP)(
  'installed Claude adapter completes wake -> tool result -> assistant end_turn -> result with a pending wake', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-claude-adapter-completion-'));
    const context = new CommandExecutionContext(root);
    const abort = new AbortController();
    const waiting = [command('original')];
    const completed: string[] = [];
    const errors: unknown[] = [];
    let notify!: (commands?: readonly AgentCommand[]) => void;
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://fixture.invalid');
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'fixture-only');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room');
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context.path);
    const schedule = vi.fn(async () => {
      waiting.push(command('new-wake'));
      notify([waiting[0]!]);
      expect(completed).toEqual([]);
      return Response.json({scheduleId:'self-schedule'});
    });
    vi.stubGlobal('fetch', schedule);
    // The native fixture executes the real helper tool handler through this
    // local test bridge; only the daemon's schedule storage is replaced.
    const server = createServer((_req, res) => {
      void callAgentTool('wake', {action:'create', trigger:'schedule', title:'Ledger write retry',
        prompt:'Retry the ledger write', cadence:{kind:'interval', everyMinutes:30}}, 'wake')
        .then(text => res.end(JSON.stringify({text})))
        .catch(error => { errors.push(error); res.writeHead(500).end('{}'); });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as {port:number};
    const nativeProgram = join(root, 'claude.cjs');
    await writeFile(nativeProgram, nativeClaudeFixture, {mode:0o700});
    const client = new AcpClient({ agentCommand: process.env.BEELINE_TEST_CLAUDE_ACP!,
      agentLabel:'claude-agent-acp', resourceScope:'none', agentCwd:root,
      agentEnv:{ HOME:root, PATH:`${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        XDG_CONFIG_HOME:join(root,'config'), XDG_STATE_HOME:join(root,'state'),
        CLAUDE_CONFIG_DIR:join(root,'claude'), CLAUDE_CODE_EXECUTABLE:nativeProgram,
        ANTHROPIC_API_KEY:'fixture-only', FIXTURE_WAKE_URL:`http://127.0.0.1:${address.port}`,
        BEELINE_TURN_CONTEXT_FILE:context.path } });
    let running: Promise<void> | undefined;
    let originalPid: number | undefined;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return {commandProtocol:1, commands:[...waiting]};
      if (name === 'claimAgentTurn') return {commands:[waiting.shift()!]};
      if (name === 'releaseAgentTurn') return {commands:[...waiting]};
      throw new Error(`Unexpected operation ${name}`);
    });
    try {
      await startAgentProcess(client);
      const {sessionId} = await client.sessionNew({cwd:root});
      originalPid = client.processPid();
      running = runServerCommandIntake({api:{execute} as unknown as DaemonApiClient,
        roomId:'room', agentId:'ruby', context, signal:abort.signal, stop:vi.fn(),
        onError:error => errors.push(error), onWake:wake => { if(wake) notify=wake; },
        run:async item => {
          const result = await client.sessionPrompt(sessionId, item.source.body);
          expect(result.stopReason).toBe('end_turn');
          expect(result.agentText).toBe('Finished.');
          if(item.id === 'original') expect(result.toolCalls).toEqual([expect.objectContaining({
            title:expect.stringContaining('wake'), status:'completed',
          })]);
          expect(client.processPid()).toBe(originalPid);
          completed.push(item.id);
          if(completed.length === 2) abort.abort();
        } });
      await running;
      expect(schedule).toHaveBeenCalledOnce();
      expect(completed).toEqual(['original','new-wake']);
      expect(errors).toEqual([]);
    } finally {
      abort.abort();
      await stopAgentProcess(client);
      await running;
      await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(root,{recursive:true,force:true});
    }
  },
);

const nativeClaudeFixture = String.raw`#!/usr/bin/env node
const {randomUUID} = require('node:crypto');
const input = require('node:readline').createInterface({input:process.stdin});
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
let first = true;
const assistant = (content, stop_reason) => send({type:'assistant',uuid:randomUUID(),
  session_id:'native-session',parent_tool_use_id:null,message:{id:randomUUID(),type:'message',
    role:'assistant',model:'claude-opus-4-6',content,stop_reason,stop_sequence:null,
    usage:{input_tokens:10,output_tokens:5}}});
input.on('line',line => { void (async () => {
  const r = JSON.parse(line);
  if(r.type === 'control_request') {
    const response = r.request.subtype === 'initialize' ? {commands:[],agents:[],
      models:[{value:'claude-opus-4-6',displayName:'Claude Opus',description:'Fixture'}],
      account:{},output_style:'default',available_output_styles:['default'],claude_code_version:'2.1.319'} : {};
    send({type:'control_response',response:{subtype:'success',request_id:r.request_id,response}});
  }
  if(r.type !== 'user') return;
  send({...r,session_id:'native-session',parent_tool_use_id:null});
  if(first) {
    first = false;
    assistant([{type:'tool_use',id:'wake',name:'mcp__beeline-agent__wake',input:{action:'create',
      trigger:'schedule',title:'Ledger write retry',prompt:'Retry the ledger write',
      cadence:{kind:'interval',everyMinutes:30}}}],'tool_use');
    const {text} = await (await fetch(process.env.FIXTURE_WAKE_URL)).json();
    send({type:'user',uuid:randomUUID(),session_id:'native-session',parent_tool_use_id:null,
      message:{role:'user',content:[{type:'tool_result',tool_use_id:'wake',content:text,is_error:false}]}});
  }
  assistant([{type:'text',text:'Finished.'}],'end_turn');
  send({type:'result',subtype:'success',is_error:false,duration_ms:1,duration_api_ms:1,
    num_turns:1,result:'Finished.',stop_reason:'end_turn',session_id:'native-session',total_cost_usd:0,
    usage:{input_tokens:10,output_tokens:5},modelUsage:{},permission_denials:[],uuid:randomUUID()});
})().catch(error => { console.error(error); process.exitCode=1; }); });
`;
