import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  AcpClient,
  agentStreamSnapshot,
  isPureRetryNarration,
  type SessionUpdate,
} from './acp.js';

const temporaryDirectories: string[] = [];

describe('ACP streaming lane classifier', () => {
  const update = (sessionUpdate: string, fields: Record<string, unknown> = {}): SessionUpdate => ({
    sessionId: 'session-1',
    update: { sessionUpdate, ...fields },
  });

  it('maps standard message, thought, and tool shapes without folding thought into the answer', () => {
    expect(
      agentStreamSnapshot([
        update('agent_thought_chunk', { content: { type: 'text', text: 'Checking ' } }),
        update('agent_thought_chunk', { content: { type: 'text', text: 'the gate' } }),
        update('tool_call', { toolCallId: 'gate', title: 'Certification gate' }),
        update('agent_message_chunk', { content: { type: 'text', text: 'The answer ' } }),
        update('agent_message_chunk', { content: { type: 'text', text: 'persists.' } }),
      ]),
    ).toEqual({ messageText: 'The answer persists.', thoughtText: 'Checking the gate' });
  });

  it('moves Goose-style pre-tool message narration into the rolling thought lane', () => {
    expect(
      agentStreamSnapshot([
        update('agent_message_chunk', { content: { type: 'text', text: 'Inspecting files' } }),
        update('tool_call', { toolCallId: 'read', kind: 'read' }),
        update('agent_message_chunk', { content: { type: 'text', text: 'Found the answer.' } }),
      ]),
    ).toEqual({ messageText: 'Found the answer.', thoughtText: 'Inspecting files' });
  });

  it('maps generic harness progress narration to the ephemeral thought lane', () => {
    expect(
      agentStreamSnapshot([
        update('progress_update', { content: { type: 'text', text: 'Reading the workspace' } }),
      ]),
    ).toEqual({ messageText: '', thoughtText: 'Reading the workspace' });
  });
});

describe('harness retry narration is never the final answer', () => {
  /** Verbatim capture: Room `charles`, 18:42 — a flaked pi/ox-alpha turn whose
   *  ONLY output was this text, which used to be published as the durable
   *  `#t=agent-message` reply and marked the request delivered. */
  const CAPTURED = 'Retrying (attempt 1/3, waiting 2s)...Retrying...Retry finished, resuming.';

  it('classifies the captured retry-narration family as pure narration', () => {
    expect(isPureRetryNarration(CAPTURED)).toBe(true);
    expect(isPureRetryNarration('Retrying (attempt 2/3, waiting 4s)...')).toBe(true);
    expect(
      isPureRetryNarration(
        'Retrying...\nRetrying (attempt 3/3, waiting 8s)...\nRetry finished, resuming.',
      ),
    ).toBe(true);
    expect(isPureRetryNarration('(attempt 1/5, backoff 1s)')).toBe(true);
    // Emptiness is not narration — callers treat it separately.
    expect(isPureRetryNarration('')).toBe(false);
    expect(isPureRetryNarration('   ')).toBe(false);
  });

  it('never suppresses genuine prose that merely mentions retries', () => {
    expect(isPureRetryNarration('I retried the deploy twice; the second run succeeded.')).toBe(
      false,
    );
    expect(
      isPureRetryNarration('Resuming work: the fix lands in src/auth.ts and every test passes.'),
    ).toBe(false);
    expect(isPureRetryNarration("The retry finished, but here's what you asked for: 42.")).toBe(
      false,
    );
    expect(
      isPureRetryNarration(
        'Retrying (attempt 1/3, waiting 2s)... the model recovered and answered: yes.',
      ),
    ).toBe(false);
  });

  it('selects nothing for an all-narration turn and the genuine answer exactly once after narration', async () => {
    const client = new AcpClient({ agentBinary: await fakePiRetryAgent(), agentEnv: {} });
    await client.start();
    try {
      const { sessionId } = await client.sessionNew({ cwd: tmpdir() });

      // The live 18:42 shape: the provider flaked and streamed only retries.
      const narrationOnly = await client.sessionPrompt(sessionId, 'ONLY-NARRATION', 5_000);
      expect(narrationOnly.updates.length).toBeGreaterThan(0);
      expect(narrationOnly.agentText).toBe('');

      // A later genuine answer after retry narration stays publishable, once.
      const withAnswer = await client.sessionPrompt(sessionId, 'NARRATION-THEN-ANSWER', 5_000);
      expect(withAnswer.agentText).toBe('The deploy is fixed and every test passes.');
      expect(withAnswer.agentText).not.toContain('Retrying');
    } finally {
      await client.stop();
    }
  });
});

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

async function fakeAutonomyAgent(
  fileName: 'codex-acp.mjs' | 'claude-agent-acp.mjs' | 'pi-acp.mjs',
  availableModes: string[],
  expectedMode?: string,
): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-autonomy-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, fileName);
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const availableModes = ${JSON.stringify(availableModes)};
const expectedMode = ${JSON.stringify(expectedMode)};
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        sessionId: 'autonomy-session',
        modes: {
          currentModeId: 'default',
          availableModes: availableModes.map((id) => ({ id })),
        },
      },
    });
  } else if (message.method === 'session/set_mode') {
    if (!expectedMode || message.params.modeId !== expectedMode) process.exit(71);
    send({ jsonrpc: '2.0', id: message.id, result: {} });
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

async function fakeSlowStreamingAgent(chunkDelayMs: number, chunkCount: number): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-slow-stream-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-slow-streaming-agent.mjs');
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
    params: { sessionId: 'slow-stream-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'slow-stream-session' } });
  } else if (message.method === 'session/prompt') {
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      chunk('chunk' + sent + ' ');
      if (sent >= ${chunkCount}) {
        clearInterval(timer);
        send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      }
    }, ${chunkDelayMs});
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

/** Narrates, gets interrupted by a tool call, then resumes narrating with no
 *  separating whitespace of its own — matching how a real harness's deltas
 *  behave when the model treats a resumed reply as a fresh thought. */
async function fakeInterruptedNarrationAgent(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-interrupted-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-interrupted-narration-agent.mjs');
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
    params: { sessionId: 'interrupted-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });
const toolCall = () =>
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 'interrupted-session', update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', kind: 'read' } },
  });

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'interrupted-session' } });
  } else if (message.method === 'session/prompt') {
    chunk('...existing test and typecheck patterns');
    toolCall();
    chunk('Now I have the full picture.');
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

/** Pi-shaped flaked provider: one turn streams ONLY retry/backoff narration
 *  (the captured Room-`charles` shape); a later turn on the same session
 *  narrates retries around tool work and then answers genuinely. */
async function fakePiRetryAgent(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-pi-retry-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-pi-retry-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const update = (update) =>
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'pi-retry-session', update } });
const chunk = (text) =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const tool = (id) =>
  update({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'read', status: 'completed' });

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'pi-retry-session' } });
  } else if (message.method === 'session/prompt') {
    const prompt = message.params.prompt.map((part) => part.text).join('');
    if (prompt.includes('ONLY-NARRATION')) {
      chunk('Retrying (attempt 1/3, waiting 2s)');
      chunk('...Retrying...');
      chunk('Retry finished, resuming.');
    } else {
      chunk('Retrying (attempt 1/3, waiting 2s)...');
      tool('probe-1');
      chunk('Retrying (attempt 2/3, waiting 4s)...Retry finished, resuming.');
      tool('probe-2');
      chunk('The deploy is fixed and every test passes.');
    }
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

/** Goose-shaped verbose stream: three progress messages around tool updates,
 * a replay of the second message, then one final response. */
async function fakeVerboseGooseAgent(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-goose-stream-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-goose-streaming-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const update = (update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'goose-stream-session', update } });
const chunk = (text, created) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, _meta: { goose: { created } } });
const tool = (id) => update({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'read', status: 'completed' });

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'goose-stream-session' } });
  } else if (message.method === 'session/prompt') {
    chunk('I am mapping the call graph.', 1);
    tool('read-1');
    chunk('I confirmed the publishing path.', 2);
    tool('read-2');
    chunk('I confirmed the publishing path.', 2);
    tool('read-2-replay');
    chunk('I am checking the tests now.', 3);
    tool('read-3');
    chunk('Fixed the publisher and all tests pass.', 4);
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

/** Emits the model's very first token, gets interrupted by a non-text update
 *  before the second token of the SAME word arrives, then finishes the
 *  sentence — the live stream-head shape that made a corner's first message
 *  render as `'ll take a look at the README first.` */
async function fakeWordSplitNarrationAgent(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-word-split-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-word-split-narration-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const update = (update) =>
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'word-split-session', update } });
const chunk = (text) =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'word-split-session' } });
  } else if (message.method === 'session/prompt') {
    chunk('I');
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'checking' } });
    chunk("'ll take a look at the README first.");
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

async function fakeWedgedAgent(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-wedged-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-wedged-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'wedged-session' } });
  } else if (message.method === 'session/prompt') {
    // Deliberately never replies and never sends a session/update: simulates
    // a wedged ACP process with zero activity for the whole turn.
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

async function fakeDescendantAgent(pidFile: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-descendant-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-descendant-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
});
writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  }
  // Ignore shutdown so AcpClient must kill the process group.
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

async function fakeAuthFailingAgent(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-authfail-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-authfail-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
process.stderr.write('Error: ANTHROPIC_API_KEY is not set. Please run \`claude login\`.\\n');
process.exit(1);
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

describe('AcpClient live steering', () => {
  it.runIf(process.platform !== 'win32')('kills the harness and all tool descendants', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-pid-'));
    temporaryDirectories.push(directory);
    const pidFile = resolve(directory, 'descendant.pid');
    const client = new AcpClient({
      agentBinary: await fakeDescendantAgent(pidFile),
      agentEnv: {},
    });
    await client.start();
    const descendantPid = Number(await readFile(pidFile, 'utf8'));

    await client.stop();

    await expect
      .poll(() => {
        try {
          process.kill(descendantPid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      })
      .toBe(true);
  });

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

  it.each([
    ['codex-acp.mjs', ['agent', 'agent-full-access'], 'agent-full-access'],
    ['claude-agent-acp.mjs', ['default', 'acceptEdits', 'bypassPermissions'], 'bypassPermissions'],
    ['pi-acp.mjs', ['high', 'medium'], undefined],
  ] as const)(
    'puts edit sessions into the %s no-prompt mode',
    async (fileName, availableModes, expectedMode) => {
      const client = new AcpClient({
        agentCommand: await fakeAutonomyAgent(fileName, [...availableModes], expectedMode),
        agentEnv: {},
      });
      await client.start();
      await expect(client.sessionNew({ cwd: process.cwd(), mode: 'edit' })).resolves.toMatchObject({
        sessionId: 'autonomy-session',
      });
      await client.stop();
    },
  );

  it('carries the child process stderr tail into a spawn/exit failure', async () => {
    const client = new AcpClient({
      agentCommand: await fakeAuthFailingAgent(),
      agentEnv: {},
    });

    await expect(client.start()).rejects.toThrow(
      /ACP agent .* exited code=1 signal=null: Error: ANTHROPIC_API_KEY is not set\. Please run `claude login`\./,
    );
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

  it('keeps interim narration in the live draft but returns only the final post-tool message', async () => {
    const client = new AcpClient({
      agentBinary: await fakeInterruptedNarrationAgent(),
      agentEnv: {},
    });
    await client.start();
    try {
      const { sessionId } = await client.sessionNew({ cwd: tmpdir() });
      const seenFullText: string[] = [];
      const snapshots: Array<{ messageText: string; thoughtText?: string }> = [];
      const result = await client.sessionPrompt(
        sessionId,
        'go',
        5_000,
        (_delta, fullText) => {
          seenFullText.push(fullText);
        },
        (snapshot) => {
          if (snapshot) snapshots.push(snapshot);
        },
      );
      expect(result.agentText).not.toContain('patternsNow');
      expect(result.agentText).toBe('Now I have the full picture.');
      expect(seenFullText.at(-1)).toBe(
        '...existing test and typecheck patterns\n\nNow I have the full picture.',
      );
      expect(snapshots).toContainEqual(
        expect.objectContaining({ thoughtText: '...existing test and typecheck patterns' }),
      );
      expect(snapshots.at(-1)).toEqual({
        messageText: 'Now I have the full picture.',
        thoughtText: '...existing test and typecheck patterns',
      });
    } finally {
      await client.stop();
    }
  });

  it('deduplicates a replayed Goose message run and selects one final output', async () => {
    const client = new AcpClient({
      agentBinary: await fakeVerboseGooseAgent(),
      agentEnv: {},
    });
    await client.start();
    try {
      const { sessionId } = await client.sessionNew({ cwd: tmpdir() });
      const seenFullText: string[] = [];
      const result = await client.sessionPrompt(sessionId, 'go', 5_000, (_delta, fullText) => {
        seenFullText.push(fullText);
      });

      expect(result.agentText).toBe('Fixed the publisher and all tests pass.');
      expect(seenFullText.at(-1)).toBe(
        [
          'I am mapping the call graph.',
          'I confirmed the publishing path.',
          'I am checking the tests now.',
          'Fixed the publisher and all tests pass.',
        ].join('\n\n'),
      );
      expect(seenFullText.at(-1)!.match(/I confirmed the publishing path\./g)).toHaveLength(1);
    } finally {
      await client.stop();
    }
  });

  it('keeps the first characters of a turn when a non-text update splits the opening word', async () => {
    // Live stream-head defect: any non-text session/update landing between the
    // model's first token and its second earned a synthetic paragraph break
    // mid-word, and the narrative committer then published the one-character
    // head as its own transcript message — so the corner's first visible
    // message began "'ll take a look at the README first."
    const client = new AcpClient({
      agentBinary: await fakeWordSplitNarrationAgent(),
      agentEnv: {},
    });
    await client.start();
    try {
      const { sessionId } = await client.sessionNew({ cwd: tmpdir() });
      const seenFullText: string[] = [];
      const result = await client.sessionPrompt(sessionId, 'go', 5_000, (_delta, fullText) => {
        seenFullText.push(fullText);
      });
      expect(result.agentText).toBe("I'll take a look at the README first.");
      expect(result.agentText.startsWith('I')).toBe(true);
      expect(result.agentText).not.toContain('\n\n');
      // The live draft carries the same unbroken sentence, not a one-character
      // head followed by its own tail.
      expect(seenFullText.at(-1)).toBe(result.agentText);
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

  it('does not time out a turn that keeps streaming activity past the idle window, and resolves once it finishes', async () => {
    // 8 chunks every 80ms = ~640ms of total turn time, well past the 200ms
    // idle timeout — each chunk must re-arm the timer or this turn dies.
    const client = new AcpClient({
      agentBinary: await fakeSlowStreamingAgent(80, 8),
      agentEnv: {},
    });
    await client.start();
    try {
      const { sessionId } = await client.sessionNew({ cwd: tmpdir() });
      const started = Date.now();
      const result = await client.sessionPrompt(sessionId, 'go', 200);
      expect(Date.now() - started).toBeGreaterThan(200);
      expect(result.agentText).toBe('chunk1 chunk2 chunk3 chunk4 chunk5 chunk6 chunk7 chunk8 ');
      expect(result.stopReason).toBe('end_turn');
    } finally {
      await client.stop();
    }
  });

  it('cancels a turn that goes fully idle (zero ACP activity) for the timeout window', async () => {
    const client = new AcpClient({ agentBinary: await fakeWedgedAgent(), agentEnv: {} });
    await client.start();
    try {
      const { sessionId } = await client.sessionNew({ cwd: tmpdir() });
      const started = Date.now();
      await expect(client.sessionPrompt(sessionId, 'go', 200)).rejects.toThrow(
        'ACP session/prompt timed out after 200ms of inactivity',
      );
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      await client.stop();
    }
  });
});

describe('AcpClient failure reporting', () => {
  it('names the configured harness, not the OS sandbox wrapper, when the child dies', async () => {
    // Under `bwrap-sandbox.ts` the spawned command IS bwrap, so without an
    // explicit label every harness crash would be reported as a bwrap crash —
    // and the daemon's log reads this text to tell a missing API key
    // from an unavailable harness.
    const client = new AcpClient({
      agentCommand: '/bin/sh',
      // Stay alive long enough for the request to be registered, so the exit
      // rejects a real pending call rather than racing the write.
      agentArgs: ['-c', 'echo "missing API key" >&2; sleep 0.4; exit 3'],
      agentLabel: 'pi-acp',
      agentEnv: {},
    });
    // `start()` awaits the ACP `initialize` handshake, so a child that dies
    // instead of answering surfaces exactly here.
    await expect(client.start()).rejects.toThrow(/ACP agent pi-acp exited code=3/);
    // The stderr tail rides along, so the log carries the real reason.
    await expect(client.start()).rejects.toThrow(/missing API key/);
  });

  it('falls back to the spawned command when no label is given', async () => {
    const client = new AcpClient({
      agentCommand: '/bin/sh',
      agentArgs: ['-c', 'sleep 0.4; exit 4'],
      agentEnv: {},
    });
    await expect(client.start()).rejects.toThrow(/ACP agent \/bin\/sh exited code=4/);
  });
});
