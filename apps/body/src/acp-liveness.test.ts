import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { AcpClient, AcpRuntimeExitedError, AcpTurnBackstopError, TURN_BACKSTOP_MS } from './acp.js';
import { callAgentTool } from './read-only-mcp.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import { classifyTurnSilence, phraseTurnSilence } from '@beeline/api-contract/daemon';

// A real ACP subprocess, controlled over the same stdio transport as a harness.
const agentSource = `
import { createInterface } from 'node:readline';
import { closeSync } from 'node:fs';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const prompts = new Map();
let sessions = 0;
const update = (sessionId, value) => send({jsonrpc:'2.0', method:'session/update', params:{sessionId, update:value}});
createInterface({input:process.stdin}).on('line', (line) => {
  const m = JSON.parse(line);
  const p = m.params;
  const reply = (result) => send({jsonrpc:'2.0', id:m.id, result});
  if (m.method === 'initialize') reply({protocolVersion:1});
  if (m.method === 'session/new') reply({sessionId:'session-' + ++sessions});
  if (m.method === 'session/prompt') {
    prompts.set(p.sessionId, m.id);
    const action = p.prompt[0].text;
    if (action === 'tool') update(p.sessionId, {sessionUpdate:'tool_call', toolCallId:'poll', status:'in_progress'});
    if (action === 'exit') process.exit(7);
    if (action === 'killed') process.kill(process.pid, 'SIGKILL');
    if (action === 'stdout') { closeSync(1); setInterval(() => {}, 1000); }
    if (action === 'stdin') {
      process.stdin.destroy();
      setTimeout(() => {
        try { closeSync(0); } catch {}
        update(p.sessionId, {sessionUpdate:'pipe_closed'});
      }, 20);
      setInterval(() => {}, 1000);
    }
    if (action === 'normal') {
      update(p.sessionId, {sessionUpdate:'agent_message_chunk', content:{type:'text',text:'Turn finished normally.'}});
      reply({stopReason:'end_turn'});
    }
  }
  if (m.method === 'session/set_model') {
    const value = JSON.parse(p.modelId);
    const target = value.target ?? p.sessionId;
    if (value.complete) {
      update(p.sessionId, {sessionUpdate:'tool_call_update', toolCallId:'poll', status:'completed'});
      update(p.sessionId, {sessionUpdate:'agent_message_chunk', content:{type:'text',text:'Release poll finished normally.'}});
      send({jsonrpc:'2.0',id:prompts.get(p.sessionId),result:{stopReason:'end_turn'}});
    } else if (value.response) {
      // Only the response below is activity.
    } else if (value.request) {
      send({jsonrpc:'2.0', id:'agent-request', method:value.request, params:{sessionId:target,options:[]}});
    } else if (value.notification) {
      send({jsonrpc:'2.0',method:value.notification,params:{sessionId:target}});
    } else update(target, value);
    reply({});
  }
  if (m.method === 'session/cancel') {
    update(p.sessionId, {sessionUpdate:'cancel_observed'});
    send({jsonrpc:'2.0',id:prompts.get(p.sessionId),result:{stopReason:'cancelled'}});
  }
  if (m.method === 'shutdown') process.exit(0);
});
`;

describe('ACP turn liveness over real stdio', () => {
  let root: string;
  let client: AcpClient;
  let sessionId: string;
  let agentEnv: Record<string, string>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'beeline-acp-liveness-'));
    const script = join(root, 'agent.mjs');
    await writeFile(script, agentSource);
    const contextPath = join(root, 'turn.json');
    await writeFile(contextPath, JSON.stringify({ roomId: 'room', requestId: 'turn', generationId: 'generation', commandReason: 'report' }));
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', contextPath);
    agentEnv = { BEELINE_TURN_CONTEXT_FILE: contextPath };
    client = new AcpClient({
      agentCommand: process.execPath,
      agentArgs: [script],
      agentEnv,
      agentLabel: 'test-runtime',
      oomKills: { prime: async () => undefined, consume: async () => false },
    });
    await client.start();
    ({ sessionId } = await client.sessionNew({ cwd: root }));
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await client.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('FREE-ABUSE-1: cancels a busy free-agent turn at the wall clock cap and returns a continuation note', async () => {
    agentEnv.BEELINE_FREE_AGENT_ID = 'free-agent';
    agentEnv.BEELINE_FREE_AGENT_MAX_TURN_SECONDS = '900';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const opened = once(client, 'session/update');
    const prompt = client.sessionPrompt(sessionId, 'tool');
    await opened;
    const cancel = vi.spyOn(client, 'sessionCancel');
    for (let minute = 0; minute < 14; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await client.setModel(sessionId, JSON.stringify({ sessionUpdate: 'tool_call_update', toolCallId: 'poll', status: 'in_progress' }));
    }
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cancel).toHaveBeenCalledWith(sessionId);
    expect(await prompt).toMatchObject({ stopReason: 'free-agent-time-limit', agentText: expect.stringContaining('Send another message') });
  });

  it('Reproduction LOOP-1: successful no_reply_needed immediately settles without a final reply', async () => {
    const opened = once(client, 'session/update');
    let settled = false;
    const prompt = client.sessionPrompt(sessionId, 'tool').then(result => { settled = true; return result; });
    await opened;
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost');
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
    vi.stubEnv('BEELINE_EXPLICIT_SILENT_RECEIPT', '1');
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    expect(JSON.parse(await callAgentTool('no_reply_needed', {}, 'silent'))).toEqual({ acknowledged: true });
    for (let i = 1; i < 2800; i++) {
      await expect(callAgentTool('no_reply_needed', {}, 'silent-' + i)).rejects.toThrow('turn has ended');
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(settled).toBe(true);
    expect((await prompt).agentText).toBe('');
    const wire = vi.spyOn(client as unknown as { write: (message: unknown) => void }, 'write');
    await (client as unknown as { handlePermission: (id: string, params: unknown) => Promise<void> }).handlePermission(
      'after-end', { sessionId, options: [{ optionId: 'allow', kind: 'allow_once' }] },
    );
    expect(wire).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 'after-end', result: { outcome: { outcome: 'cancelled' } } });
    wire.mockRestore();
    console.log('Reproduction LOOP-1: first successful no_reply_needed → prompt ended with no final text');
  });

  it.each(['mcp__agent__read', 'execute', 'custom_external_tool'])('stops five identical %s calls and releases the next prompt', async title => {
    const opened = once(client, 'session/update');
    const prompt = client.sessionPrompt(sessionId, 'tool');
    await opened;
    for (let i = 0; i < 5; i++) {
      await client.setModel(sessionId, JSON.stringify({ sessionUpdate: 'tool_call', toolCallId: 'repeat-' + i,
        title, rawInput: i % 2 ? { b: 2, a: 1 } : { a: 1, b: 2 }, status: 'in_progress' }));
    }
    expect(await prompt).toMatchObject({ stopReason: 'repeated-tool-call', agentText: '' });
    await writeFile(join(root, 'turn.json'), JSON.stringify({ roomId: 'room', requestId: 'next-turn', generationId: 'generation', commandReason: 'report' }));
    const next = await client.sessionNew({ cwd: root });
    expect((await client.sessionPrompt(next.sessionId, 'normal')).agentText).toBe('Turn finished normally.');
  });

  it('Charles regression: five identical invalid login calls stop once without promoting pre-tool narration', async () => {
    const opened = once(client, 'session/update');
    const prompt = client.sessionPrompt(sessionId, 'tool');
    await opened;
    await client.setModel(sessionId, JSON.stringify({ sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'I will sign in now.' } }));
    for (let i = 0; i < 5; i++) {
      await client.setModel(sessionId, JSON.stringify({ sessionUpdate: 'tool_call', toolCallId: 'login-' + i,
        title: 'mcp__squire__operate_login', rawInput: {}, status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'Schema validation failed: missing action' } }] }));
    }
    const result = await prompt;
    expect(result).toMatchObject({ stopReason: 'repeated-tool-call', agentText: '' });
    const logins = result.toolCalls.filter(call => call.title === 'mcp__squire__operate_login');
    expect(logins).toHaveLength(5);
    expect(logins.every(call => call.status === 'failed')).toBe(true);
  });

  it('counts no-argument tools and resets on a different tool', async () => {
    const opened = once(client, 'session/update');
    const prompt = client.sessionPrompt(sessionId, 'tool');
    await opened;
    for (let i = 0; i < 9; i++) {
      await client.setModel(sessionId, JSON.stringify({ sessionUpdate: 'tool_call', toolCallId: 'empty-' + i,
        title: i < 4 ? 'status' : 'ping', status: 'completed' }));
    }
    expect((await prompt).stopReason).toBe('repeated-tool-call');
  });

  it('four identical calls then different arguments reset the guard; updates do not count as calls', async () => {
    const opened = once(client, 'session/update');
    const prompt = client.sessionPrompt(sessionId, 'tool');
    await opened;
    for (let i = 0; i < 8; i++) {
      await client.setModel(sessionId, JSON.stringify({ sessionUpdate: 'tool_call', toolCallId: 'read-' + i,
        title: 'read', rawInput: { path: i < 4 ? 'a' : 'b' }, status: 'in_progress' }));
      await client.setModel(sessionId, JSON.stringify({ sessionUpdate: 'tool_call_update', toolCallId: 'read-' + i,
        status: 'completed' }));
    }
    await client.setModel(sessionId, JSON.stringify({ complete: true }));
    expect((await prompt).stopReason).toBe('end_turn');
  });

  it('Reproduction ACP-L1: a silent release tool survives 40 minutes and finishes normally', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const opened = once(client, 'session/update');
    let failure: unknown;
    const prompt = client.sessionPrompt(sessionId, 'tool').catch((error) => {
      failure = error;
      return undefined;
    });
    await opened;
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(failure).toBeUndefined();
    await client.setModel(sessionId, JSON.stringify({ complete: true }));
    expect((await prompt)?.agentText).toBe('Release poll finished normally.');
    console.log('Reproduction ACP-L1: 40 silent tool minutes → Release poll finished normally.');
  });

  it('bounds an abandoned open tool instead of leaving its prompt claimed forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const opened = once(client, 'session/update');
    const idle = client.sessionPrompt(sessionId, 'tool').catch((error) => error);
    await opened;
    const cancel = vi.spyOn(client, 'sessionCancel');
    await vi.advanceTimersByTimeAsync(TURN_BACKSTOP_MS);
    expect(cancel).toHaveBeenCalledWith(sessionId);
    expect(await idle).toBeInstanceOf(AcpTurnBackstopError);
    expect(client.isAlive).toBe(true);
  });

  it.each(['exit', 'killed', 'stdout', 'stdin'])(
    'reports %s promptly as runtime_exited',
    async (action) => {
      const started = Date.now();
      const closed = once(client, 'session/update');
      const outcome = client.sessionPrompt(sessionId, action).catch((error) => error);
      if (action === 'stdin') {
        await closed;
        await client.setModel(sessionId, '{}').catch(() => undefined);
      }
      const error = await outcome;
      expect(error).toBeInstanceOf(AcpRuntimeExitedError);
      expect(Date.now() - started).toBeLessThan(1000);
      const reason = distillTurnFailureReason(error);
      expect(reason.text).toContain('runtime_exited');
      expect(
        phraseTurnSilence('Bee', classifyTurnSilence(reason.text, reason.kind)).consequence,
      ).toContain('runtime_exited');
      console.log(`Reproduction ACP-L1: ${action} → ${reason.text}`);
    },
  );

  it('reports a killed runtime even when its OOM diagnostic never answers', async () => {
    await client.stop();
    client = new AcpClient({
      agentCommand: process.execPath,
      agentArgs: [join(root, 'agent.mjs')],
      agentEnv: {},
      oomKills: { prime: async () => undefined, consume: () => new Promise(() => {}) },
    });
    await client.start();
    ({ sessionId } = await client.sessionNew({ cwd: root }));
    const started = Date.now();
    const error = await client.sessionPrompt(sessionId, 'killed').catch((error) => error);
    expect(error).toBeInstanceOf(AcpRuntimeExitedError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('cancels only the silent session at the backstop, preserving a sibling tool and the runtime', async () => {
    const sibling = (await client.sessionNew({ cwd: root })).sessionId;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const opened = once(client, 'session/update');
    const surviving = client.sessionPrompt(sibling, 'tool');
    await opened;
    const cancel = vi.spyOn(client, 'sessionCancel');
    const idle = client.sessionPrompt(sessionId, 'silent').catch((error) => error);
    await vi.advanceTimersByTimeAsync(TURN_BACKSTOP_MS / 2);
    await client.setModel(sibling, JSON.stringify({ sessionUpdate: 'tool_call_update', toolCallId: 'poll', status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(TURN_BACKSTOP_MS / 2 - 1);
    expect(cancel).not.toHaveBeenCalled();
    const observed = once(client, 'session/update');
    await vi.advanceTimersByTimeAsync(1);
    const error = await idle;
    expect(error).toBeInstanceOf(AcpTurnBackstopError);
    expect(error.message).toContain('45 minutes; last activity: session/prompt');
    expect((await observed)[0].update.sessionUpdate).toBe('cancel_observed');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(sessionId);
    expect(client.isAlive).toBe(true);
    await client.setModel(sibling, JSON.stringify({ complete: true }));
    expect((await surviving).agentText).toBe('Release poll finished normally.');
    expect((await client.sessionPrompt(sessionId, 'normal')).agentText).toBe(
      'Turn finished normally.',
    );
  });

  it.each([
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } },
    { sessionUpdate: 'plan', entries: [] },
    { sessionUpdate: 'available_commands_update', availableCommands: [] },
    { sessionUpdate: 'tool_call', toolCallId: 'done', status: 'completed' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'done', status: 'failed' },
    { request: 'session/request_permission' },
    { request: 'fs/read_text_file' },
    { notification: 'custom/progress' },
    { response: true },
  ])('resets the session backstop on inbound %j', async (activity) => {
    // Send from a separate control session so its RPC response cannot mask
    // whether the notification or agent request refreshed the tested session.
    const control = (await client.sessionNew({ cwd: root })).sessionId;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let failure: unknown;
    const prompt = client.sessionPrompt(sessionId, 'silent').catch((error) => {
      failure = error;
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(TURN_BACKSTOP_MS - 1);
    await client.setModel(
      'response' in activity ? sessionId : control,
      JSON.stringify({ ...activity, target: sessionId }),
    );
    await vi.advanceTimersByTimeAsync(TURN_BACKSTOP_MS - 1);
    expect(failure).toBeUndefined();
    await client.setModel(sessionId, JSON.stringify({ complete: true }));
    expect((await prompt)?.stopReason).toBe('end_turn');
  });

  it('names the actual last inbound activity when the backstop expires', async () => {
    const control = (await client.sessionNew({ cwd: root })).sessionId;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const idle = client.sessionPrompt(sessionId, 'silent').catch((error) => error);
    await client.setModel(
      control,
      JSON.stringify({ target: sessionId, sessionUpdate: 'plan', entries: [] }),
    );
    await vi.advanceTimersByTimeAsync(TURN_BACKSTOP_MS);
    expect((await idle).message).toBe(
      'turn_backstop: no ACP traffic for 45 minutes; last activity: plan',
    );
  });

  it('does not let sibling activity refresh a silent session', async () => {
    const sibling = (await client.sessionNew({ cwd: root })).sessionId;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const idle = client.sessionPrompt(sessionId, 'silent').catch((error) => error);
    await vi.advanceTimersByTimeAsync(TURN_BACKSTOP_MS - 1);
    await client.setModel(sibling, JSON.stringify({ sessionUpdate: 'plan', entries: [] }));
    await vi.advanceTimersByTimeAsync(1);
    expect(await idle).toBeInstanceOf(AcpTurnBackstopError);
  });

  it('re-arms the idle window on tool progress and completion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let failure: unknown;
    const prompt = client.sessionPrompt(sessionId, 'silent').catch((error) => {
      failure = error;
      return error;
    });
    for (const toolCallId of ['one', 'two']) {
      await client.setModel(
        sessionId,
        JSON.stringify({ sessionUpdate: 'tool_call', toolCallId, status: 'pending' }),
      );
    }
    await client.setModel(
      sessionId,
      JSON.stringify({ sessionUpdate: 'tool_call_update', toolCallId: 'one', status: 'completed' }),
    );
    // A sparse update must preserve the second tool's pending state.
    await client.setModel(
      sessionId,
      JSON.stringify({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'two',
        title: 'Release poll',
      }),
    );
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(failure).toBeUndefined();
    await client.setModel(
      sessionId,
      JSON.stringify({ sessionUpdate: 'tool_call_update', toolCallId: 'two', status: 'failed' }),
    );
    await vi.advanceTimersByTimeAsync(TURN_BACKSTOP_MS - 1);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await prompt).toBeInstanceOf(AcpTurnBackstopError);
  });
});
