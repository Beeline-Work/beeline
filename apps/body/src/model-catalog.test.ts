import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fetchAgentModelCatalog } from './model-catalog.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fakeGrokCatalogAgent(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'beeline-grok-catalog-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'grok');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const expectedArgs = ['agent', '--model', 'grok-4.5', '--reasoning-effort', 'medium', 'stdio'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedArgs)) process.exit(64);

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
        sessionId: 'grok-session',
        models: {
          currentModelId: 'grok-4.5',
          availableModels: [
            {
              modelId: 'grok-4.6',
              name: 'Grok 4.6',
              _meta: { reasoningEffort: 'high', reasoningEfforts: [{ value: 'high' }] },
            },
            {
              modelId: 'grok-4.5',
              name: 'Grok 4.5',
              _meta: {
                reasoningEffort: 'medium',
                reasoningEfforts: [
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium', default: true },
                  { value: 'high', label: 'High' },
                ],
                'x.ai/sessionConfig': {
                  options: [{ id: 'dangerous-mode', category: 'mode', value: 'bypassPermissions' }],
                },
              },
            },
          ],
        },
      },
    });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

describe('fetchAgentModelCatalog — Grok ACP', () => {
  it('probes with selected launch args and parses session/new.models without exposing mode', async () => {
    const result = await fetchAgentModelCatalog(
      { kind: 'grok', command: await fakeGrokCatalogAgent(), args: ['agent', 'stdio'] },
      {},
      { model: 'grok-4.5', effort: 'medium' },
    );

    expect(result.raw).toEqual([
      {
        id: 'beeline:grok-session-model',
        category: 'model',
        currentValue: 'grok-4.5',
        options: [
          { id: 'grok-4.6', name: 'Grok 4.6' },
          { id: 'grok-4.5', name: 'Grok 4.5' },
        ],
      },
      {
        id: 'beeline:grok-launch-reasoning-effort',
        category: 'reasoning_effort',
        currentValue: 'medium',
        options: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
      },
    ]);
    expect(result.catalog).toEqual(result.raw);
    expect(result.catalog.some((axis) => axis.category === 'mode')).toBe(false);
  });
});
