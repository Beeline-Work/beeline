import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { AcpClient } from './acp.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
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

describe('AcpClient live steering', () => {
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
});
