import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { AcpClient } from './acp.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fakeSteerAgent(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-steer-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-steer-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let promptId;
const steers = [];

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-1' } });
  } else if (message.method === 'session/prompt') {
    promptId = message.id;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { goose: { activeRunId: 'run-original' } },
        },
      },
    });
  } else if (message.method === '_goose/unstable/session/steer') {
    if (message.params.expectedRunId !== 'run-original') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'wrong run' } });
      return;
    }
    steers.push(message.params.prompt[0].text);
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { runId: 'run-original', messageId: 'steer-' + steers.length },
    });
    if (steers.length === 2) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'incorporated:' + steers.join('|') },
          },
        },
      });
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    }
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

async function fakeArgumentAgent(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-args-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-argument-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['acp', '--profile', 'operator'])) {
  process.exit(64);
}

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let promptId;
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: 1, _meta: { steering: { supported: true } } },
    });
  } else if (message.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        sessionId: 'portable-session-id',
        modes: {
          currentModeId: 'agent',
          availableModes: [{ id: 'read-only' }, { id: 'agent' }],
        },
      },
    });
  } else if (message.method === 'session/set_mode') {
    if (message.params.sessionId !== 'portable-session-id' || message.params.modeId !== 'read-only') {
      process.exit(65);
    }
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  } else if (message.method === 'session/prompt') {
    promptId = message.id;
  } else if (message.method === '_session/steering') {
    if (!promptId || message.params.sessionId !== 'portable-session-id') process.exit(66);
    send({ jsonrpc: '2.0', id: message.id, result: { outcome: 'injected' } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

async function fakePermissionAgent(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-permission-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-permission-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let promptId;
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'permission-session' } });
  } else if (message.method === 'session/prompt') {
    promptId = message.id;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'permission-session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          kind: 'edit',
          title: 'str_replace README.md',
          rawInput: { path: 'README.md' },
          status: 'in_progress',
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'permission-session',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'in_progress',
        },
      },
    });
    send({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: {
        sessionId: 'permission-session',
        toolCall: { toolCallId: 'tool-1', kind: 'edit', status: 'pending' },
        options: [
          { kind: 'allow_once', optionId: 'allow' },
          { kind: 'reject_once', optionId: 'reject' },
        ],
      },
    });
  } else if (message.id === 99 && message.result) {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'permission-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: message.result.outcome.optionId },
        },
      },
    });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

async function fakeStreamingAgent(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-stream-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-streaming-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const chunk = (text) =>
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 'stream-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'stream-session' } });
  } else if (message.method === 'session/prompt') {
    chunk('Hel');
    chunk('lo ');
    chunk('world');
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

describe('AcpClient live steering', () => {
  it('lets the host intercept and reject a mutating permission request', async () => {
    const requests: unknown[] = [];
    const client = new AcpClient({
      agentBinary: await fakePermissionAgent(),
      agentEnv: {},
      autoApprovePermissions: false,
      permissionHandler: async (request) => {
        requests.push(request);
        return 'reject';
      },
    });
    await client.start();
    try {
      const { sessionId } = await client.sessionNew({ cwd: tmpdir() });
      const result = await client.sessionPrompt(sessionId, 'Edit README.md', 5_000);
      expect(requests).toMatchObject([
        { toolCall: { kind: 'edit', title: 'str_replace README.md' } },
      ]);
      expect(result.agentText).toBe('reject');
    } finally {
      await client.stop();
    }
  });

  it('spawns an ACP command with its configured arguments', async () => {
    const client = new AcpClient({
      agentCommand: await fakeArgumentAgent(),
      agentArgs: ['acp', '--profile', 'operator'],
      agentEnv: {},
    });

    await client.start();
    const session = await client.sessionNew({ cwd: process.cwd(), mode: 'readonly' });
    expect(session.sessionId).toBe('portable-session-id');
    const prompt = client.sessionPrompt(session.sessionId, 'first');
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(client.activeRunId(session.sessionId)).toBe(`session:${session.sessionId}`);
    await expect(client.sessionSteer(session.sessionId, 'follow-up')).resolves.toMatchObject({
      messageId: 'injected',
    });
    await prompt;
    expect(client.isAlive).toBe(true);
    await client.stop();
  });

  it('injects ordered follow-ups into the active prompt run', async () => {
    const client = new AcpClient({ agentBinary: await fakeSteerAgent(), agentEnv: {} });
    await client.start();

    try {
      const { sessionId } = await client.sessionNew({ cwd: tmpdir() });
      const originalPrompt = client.sessionPrompt(sessionId, 'original task', 5_000);

      const first = await client.sessionSteer(sessionId, 'first redirect', 5_000);
      const second = await client.sessionSteer(sessionId, 'second redirect', 5_000);
      const result = await originalPrompt;

      expect(first).toEqual({ runId: 'run-original', messageId: 'steer-1' });
      expect(second).toEqual({ runId: 'run-original', messageId: 'steer-2' });
      expect(result.agentText).toBe('incorporated:first redirect|second redirect');
      expect(client.activeRunId(sessionId)).toBeUndefined();
    } finally {
      await client.stop();
    }
  });

  it('streams agent_message_chunk deltas to onChunk as they arrive, harness-agnostic at the ACP boundary', async () => {
    const client = new AcpClient({ agentBinary: await fakeStreamingAgent(), agentEnv: {} });
    await client.start();
    try {
      const { sessionId } = await client.sessionNew({ cwd: tmpdir() });
      const seen: Array<{ delta: string; fullText: string }> = [];
      const result = await client.sessionPrompt(sessionId, 'go', 5_000, (delta, fullText) => {
        seen.push({ delta, fullText });
      });
      expect(seen).toEqual([
        { delta: 'Hel', fullText: 'Hel' },
        { delta: 'lo ', fullText: 'Hel' + 'lo ' },
        { delta: 'world', fullText: 'Hello world' },
      ]);
      expect(result.agentText).toBe('Hello world');
    } finally {
      await client.stop();
    }
  });

  it('omitting onChunk changes nothing about the final result (opt-in, no side effect)', async () => {
    const client = new AcpClient({ agentBinary: await fakeStreamingAgent(), agentEnv: {} });
    await client.start();
    try {
      const { sessionId } = await client.sessionNew({ cwd: tmpdir() });
      const result = await client.sessionPrompt(sessionId, 'go', 5_000);
      expect(result.agentText).toBe('Hello world');
    } finally {
      await client.stop();
    }
  });
});
