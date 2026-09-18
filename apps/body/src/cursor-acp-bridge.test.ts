import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { AcpClient, finalAgentMessageText } from './acp.js';
import {
  CURSOR_AGENT_FORCE_FLAG,
  CURSOR_AGENT_TRUST_FLAG,
  CursorAcpServer,
  cursorAcpBridgeLaunch,
  cursorAgentArgv,
  describeCursorTurnFailure,
  translateCursorStreamEvent,
  type CursorAgentSpawn,
} from './cursor-acp-bridge.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Verbatim stream-json shapes captured from:
 *   cursor-agent --print --output-format stream-json --force \
 *     "Reply with exactly: hello from cursor"
 */
const VERIFIED_CURSOR_STREAM = [
  { type: 'system', subtype: 'init' },
  { type: 'user' },
  { type: 'thinking', subtype: 'delta', text: 'The user wants ' },
  { type: 'thinking', subtype: 'delta', text: 'an exact reply.' },
  { type: 'thinking', subtype: 'completed' },
  {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hello from cursor' }] },
  },
  {
    type: 'result',
    subtype: 'success',
    duration_ms: 5631,
    is_error: false,
    result: 'hello from cursor',
  },
] as const;

async function fakeCursorAgent(script: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'beeline-cursor-agent-'));
  cleanup.push(directory);
  const path = resolve(directory, 'cursor-agent');
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

function spawnFake(path: string): CursorAgentSpawn {
  return (input) =>
    spawn(path, input.argv, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
}

describe('cursor stream-json → ACP', () => {
  it('maps thinking deltas to thought chunks and assistant content to the answer', () => {
    const updates = VERIFIED_CURSOR_STREAM.flatMap((event) => translateCursorStreamEvent(event));
    expect(updates).toEqual([
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'The user wants ' },
      },
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'an exact reply.' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello from cursor' },
      },
    ]);
    expect(
      finalAgentMessageText(updates.map((update) => ({ sessionId: 's', update }))),
    ).toBe('hello from cursor');
  });

  it('passes --force and the configured model through to cursor-agent', () => {
    expect(cursorAgentArgv({ prompt: 'hello from cursor', model: 'composer-2.5' })).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      CURSOR_AGENT_TRUST_FLAG,
      CURSOR_AGENT_FORCE_FLAG,
      '--model',
      'composer-2.5',
      'hello from cursor',
    ]);
    expect(cursorAgentArgv({ prompt: 'hello', model: 'auto' })).not.toContain('--model');
  });

  it('names an is_error result and a non-zero exit instead of returning empty', () => {
    expect(
      describeCursorTurnFailure({
        isError: true,
        resultText: 'Workspace Trust Required',
        exitCode: 0,
      }),
    ).toMatch(/cursor-agent reported an error: Workspace Trust Required/);
    expect(
      describeCursorTurnFailure({
        exitCode: 1,
        stderr: 'Workspace Trust Required\n',
      }),
    ).toMatch(/cursor-agent exited 1: Workspace Trust Required/);
    expect(describeCursorTurnFailure({ exitCode: 0 })).toBeUndefined();
  });
});

describe('CursorAcpServer against a streamed cursor-agent', () => {
  it('does not resolve the turn until cursor-agent emits the answer (fails the old stub)', async () => {
    const delayMs = 80;
    const agent = await fakeCursorAgent(`#!/usr/bin/env node
const events = ${JSON.stringify(VERIFIED_CURSOR_STREAM)};
setTimeout(() => {
  for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
}, ${delayMs});
`);
    const updates: Array<{ sessionUpdate?: string; content?: { text?: string } }> = [];
    let newResult: { sessionId?: string } | undefined;
    let promptResult: { stopReason?: string } | undefined;
    let promptError: string | undefined;
    const server = new CursorAcpServer({
      spawnCursorAgent: spawnFake(agent),
      enumerateModels: async () => ({ currentValue: 'auto', options: [{ id: 'auto' }] }),
      write: (message) => {
        if (message.method === 'session/update') {
          updates.push((message.params as { update: (typeof updates)[number] }).update);
        }
        if (message.id === 2) newResult = message.result as { sessionId?: string };
        if (message.id === 3) {
          if (message.error) promptError = (message.error as { message?: string }).message;
          else promptResult = message.result as { stopReason?: string };
        }
      },
    });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: tmpdir() },
    });
    const started = Date.now();
    await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: newResult?.sessionId,
        prompt: [{ type: 'text', text: 'Reply with exactly: hello from cursor' }],
      },
    });
    const elapsedMs = Date.now() - started;
    expect(promptError).toBeUndefined();
    expect(promptResult).toEqual({ stopReason: 'end_turn' });
    expect(elapsedMs).toBeGreaterThanOrEqual(delayMs);
    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      'agent_thought_chunk',
      'agent_thought_chunk',
      'agent_message_chunk',
    ]);
    expect(updates.at(-1)?.content?.text).toBe('hello from cursor');
    // The abandoned stub returns { stopReason: "end_turn" } in ~1ms with zero updates.
    expect(elapsedMs).toBeGreaterThan(5);
    expect(updates.length).toBeGreaterThan(0);
  });

  it('advertises the cursor model axis and honors session/set_config_option', async () => {
    let capturedArgv: string[] = [];
    const agent = await fakeCursorAgent(`#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
}) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) + '\\n');
`);
    const writes: Array<Record<string, unknown>> = [];
    const server = new CursorAcpServer({
      spawnCursorAgent: (input) => {
        capturedArgv = input.argv;
        return spawnFake(agent)(input);
      },
      enumerateModels: async () => ({
        currentValue: 'auto',
        options: [{ id: 'auto' }, { id: 'composer-2.5' }],
      }),
      write: (message) => writes.push(message),
    });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: tmpdir() },
    });
    const opened = writes.find((message) => message.id === 2)?.result as {
      sessionId: string;
      configOptions: Array<{ category: string; options: Array<{ id: string }> }>;
    };
    expect(opened.configOptions[0]?.category).toBe('model');
    expect(opened.configOptions[0]?.options.map((option) => option.id)).toEqual([
      'auto',
      'composer-2.5',
    ]);
    await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/set_config_option',
      params: { sessionId: opened.sessionId, configId: 'model', value: 'composer-2.5' },
    });
    await server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/prompt',
      params: {
        sessionId: opened.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      },
    });
    expect(capturedArgv).toContain('--model');
    expect(capturedArgv).toContain('composer-2.5');
    expect(capturedArgv).toContain(CURSOR_AGENT_TRUST_FLAG);
    expect(capturedArgv).toContain(CURSOR_AGENT_FORCE_FLAG);
  });

  it('fails a streamed error result with a named reason, not an empty end_turn', async () => {
    const agent = await fakeCursorAgent(`#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'error',
  is_error: true,
  result: 'Workspace Trust Required',
}) + '\\n');
`);
    const writes: Array<Record<string, unknown>> = [];
    const server = new CursorAcpServer({
      spawnCursorAgent: spawnFake(agent),
      enumerateModels: async () => ({ currentValue: 'auto', options: [{ id: 'auto' }] }),
      write: (message) => writes.push(message),
    });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: tmpdir() },
    });
    const sessionId = (writes.find((message) => message.id === 2)?.result as { sessionId: string })
      .sessionId;
    await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
    });
    const prompt = writes.find((message) => message.id === 3);
    expect(prompt?.error).toMatchObject({
      message: expect.stringContaining('cursor-agent reported an error: Workspace Trust Required'),
    });
    expect(prompt?.result).toBeUndefined();
  });

  it('fails a non-zero cursor-agent exit with stderr, not an empty end_turn', async () => {
    const agent = await fakeCursorAgent(`#!/usr/bin/env node
process.stderr.write('Workspace Trust Required\\n');
process.exit(1);
`);
    const writes: Array<Record<string, unknown>> = [];
    const server = new CursorAcpServer({
      spawnCursorAgent: spawnFake(agent),
      enumerateModels: async () => ({ currentValue: 'auto', options: [{ id: 'auto' }] }),
      write: (message) => writes.push(message),
    });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: tmpdir() },
    });
    const sessionId = (writes.find((message) => message.id === 2)?.result as { sessionId: string })
      .sessionId;
    await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
    });
    const prompt = writes.find((message) => message.id === 3);
    expect(prompt?.error).toMatchObject({
      message: expect.stringMatching(/cursor-agent exited 1: Workspace Trust Required/),
    });
    expect(prompt?.result).toBeUndefined();
  });
});

describe('AcpClient over the owned cursor ACP bridge process', () => {
  it('collects the streamed answer through the same client a Room turn uses', async () => {
    const delayMs = 60;
    const agent = await fakeCursorAgent(`#!/usr/bin/env node
if (process.argv.includes('models')) {
  process.stdout.write('auto - Auto (current, default)\\n');
  process.exit(0);
}
const events = ${JSON.stringify(VERIFIED_CURSOR_STREAM)};
setTimeout(() => {
  for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
}, ${delayMs});
`);
    const home = await mkdtemp(resolve(tmpdir(), 'beeline-cursor-home-'));
    const cwd = await mkdtemp(resolve(tmpdir(), 'beeline-cursor-cwd-'));
    cleanup.push(home, cwd);
    const launch = cursorAcpBridgeLaunch();
    const client = new AcpClient({
      agentCommand: launch.command,
      agentArgs: launch.args,
      agentLabel: 'cursor-acp-bridge',
      agentCwd: cwd,
      agentEnv: {
        PATH: `${dirname(agent)}${delimiter}${process.env.PATH ?? ''}`,
        HOME: home,
      },
    });
    try {
      await client.start(8_000);
      const { sessionId, raw } = await client.sessionNew({ cwd, timeoutMs: 8_000 });
      const catalog = raw as { configOptions?: Array<{ category?: string }> };
      expect(catalog.configOptions?.some((option) => option.category === 'model')).toBe(true);
      const started = Date.now();
      const result = await client.sessionPrompt(
        sessionId,
        'Reply with exactly: hello from cursor',
        10_000,
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(delayMs);
      expect(result.stopReason).toBe('end_turn');
      expect(result.agentText).toBe('hello from cursor');
      expect(result.updates.some((update) => update.update.sessionUpdate === 'agent_thought_chunk')).toBe(
        true,
      );
    } finally {
      await client.stop();
    }
  });
});
