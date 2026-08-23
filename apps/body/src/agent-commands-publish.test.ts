import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { AcpClient, parseAvailableCommands } from './acp.js';
import { createAgentCommandPublisher } from './agent-commands-publish.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.useRealTimers();
});

/**
 * A fake ACP agent that pushes `available_commands_update` twice: once right
 * after session/new (the shipped adapters' session-start push) and once
 * mid-prompt with a CHANGED list (skills discovered while working).
 */
async function fakeCommandsAgent(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-commands-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'fake-commands-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const commandsUpdate = (commands) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 'session-1',
    update: { sessionUpdate: 'available_commands_update', availableCommands: commands },
  },
});

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-1' } });
    setTimeout(() => {
      send(commandsUpdate([
        { name: '/loop', description: 'Run again and again' },
        { name: 'review', description: 'Review the diff', input: { hint: '[pr-number]' } },
        { name: '' },
        'junk',
      ]));
    }, 0);
  } else if (message.method === 'session/prompt') {
    send(commandsUpdate([{ name: 'review', description: 'Review the diff' }, { name: 'new-skill' }]));
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'done' },
          },
        },
      });
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    }, 10);
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

describe('AcpClient available-commands capture', () => {
  it('captures session-start and mid-session command updates, dropping malformed entries', async () => {
    const client = new AcpClient({
      agentBinary: await fakeCommandsAgent(),
      agentEnv: {},
    });
    const seen: Array<{ sessionId: string; names: string[] }> = [];
    client.on('commands', ({ sessionId, commands }) => {
      seen.push({ sessionId, names: commands.map((command) => command.name) });
    });
    await client.start();
    try {
      const { sessionId } = await client.sessionNew({ cwd: tmpdir() });
      // The session-start push is asynchronous on the adapter side.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
      expect(seen.map((entry) => entry.names)).toEqual([['loop', 'review']]);
      expect(client.sessionCommandsFor(sessionId).map((command) => command.name)).toEqual([
        'loop',
        'review',
      ]);
      // Input hints survive; junk entries do not break the pipeline.
      expect(client.sessionCommandsFor(sessionId)[1]?.inputHint).toBe('[pr-number]');
      expect(client.sessionCommandsFor('unknown-session')).toEqual([]);

      await client.sessionPrompt(sessionId, 'learn a new skill', 5_000);
      expect(seen[seen.length - 1]?.names).toEqual(['review', 'new-skill']);
      expect(client.sessionCommandsFor(sessionId).map((command) => command.name)).toEqual([
        'review',
        'new-skill',
      ]);
    } finally {
      await client.stop();
      // A stopped client forgets its per-session state with everything else.
      expect(client.sessionCommandsFor('session-1')).toEqual([]);
    }
  });

  it('parses available-command payloads defensively', () => {
    const parsed = parseAvailableCommands([
      { name: '/leading-slashes' },
      { name: 'hinted', input: { hint: '[file]' } },
      { name: 'x'.repeat(120) },
      { name: 'described', description: 'y'.repeat(400) },
      {},
      null,
    ]);
    expect(parsed.map((command) => command.name)).toEqual(['leading-slashes', 'hinted', 'described']);
    expect(parsed[1]?.inputHint).toBe('[file]');
    // Over-long fields are clamped/dropped, not thrown on.
    expect(parsed[2]?.description).toHaveLength(300);
    expect(parseAvailableCommands('not an array')).toEqual([]);
  });
});

describe('agent command list publishing', () => {
  it('debounces bursts to the last list and dedupes already-published signatures', async () => {
    vi.useFakeTimers();
    const published: string[][] = [];
    const publishedSignatures = new Set<string>();
    let failNext = false;
    const publisher = createAgentCommandPublisher({
      publish: async (commands) => {
        if (failNext) {
          failNext = false;
          throw new Error('relay down');
        }
        published.push(commands.map((command) => command.name));
      },
      publishedSignatures,
      dedupeKeyPrefix: 'community-1',
      debounceMs: 1_000,
    });

    publisher.onCommands([{ name: 'a' }]);
    publisher.onCommands([{ name: 'a' }, { name: 'b' }]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(published).toEqual([['a', 'b']]);

    // Identical list again: no second write.
    publisher.onCommands([{ name: 'a' }, { name: 'b' }]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(published).toEqual([['a', 'b']]);

    // A failed publish releases its signature so a later identical push retries.
    failNext = true;
    publisher.onCommands([{ name: 'c' }]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(published).toEqual([['a', 'b']]);
    publisher.onCommands([{ name: 'c' }]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(published).toEqual([['a', 'b'], ['c']]);

    // Empty lists are never published — absence IS "does not advertise".
    publisher.onCommands([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(published).toEqual([['a', 'b'], ['c']]);

    publisher.dispose();
  });

  it('drops a still-pending list on dispose instead of publishing after teardown', async () => {
    vi.useFakeTimers();
    const published: string[][] = [];
    const publisher = createAgentCommandPublisher({
      publish: async (commands) => {
        published.push(commands.map((command) => command.name));
      },
      publishedSignatures: new Set(),
      dedupeKeyPrefix: 'community-1',
      debounceMs: 1_000,
    });
    publisher.onCommands([{ name: 'late' }]);
    publisher.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(published).toEqual([]);
  });
});
