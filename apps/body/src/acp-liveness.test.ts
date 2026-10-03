import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { AcpClient, AcpRuntimeExitedError, AcpTurnBackstopError, TURN_BACKSTOP_MS } from './acp.js';
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
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'beeline-acp-liveness-'));
    const script = join(root, 'agent.mjs');
    await writeFile(script, agentSource);
    client = new AcpClient({
      agentCommand: process.execPath,
      agentArgs: [script],
      agentEnv: {},
      agentLabel: 'test-runtime',
      oomKills: { prime: async () => undefined, consume: async () => false },
    });
    await client.start();
    ({ sessionId } = await client.sessionNew({ cwd: root }));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await client.stop();
    await rm(root, { recursive: true, force: true });
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
    await vi.advanceTimersByTimeAsync(TURN_BACKSTOP_MS - 1);
    expect(cancel).not.toHaveBeenCalled();
    const observed = once(client, 'session/update');
    await vi.advanceTimersByTimeAsync(1);
    const error = await idle;
    expect(error).toBeInstanceOf(AcpTurnBackstopError);
    expect(error.message).toContain('30 minutes; last activity: session/prompt');
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
      'turn_backstop: no ACP traffic for 30 minutes; last activity: plan',
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

  it('keeps multiple pending tools open until the final tool completes, then starts a full window', async () => {
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
