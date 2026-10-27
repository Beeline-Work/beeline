import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from './acp.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function systemPromptAgent(advertise: boolean, agentLabel = 'codex-acp'): Promise<AcpClient> {
  const directory = await mkdtemp(join(tmpdir(), 'beeline-acp-system-prompt-'));
  directories.push(directory);
  const script = join(directory, 'agent.cjs');
  await writeFile(
    script,
    `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const send = payload => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\\n');
  if (method === 'initialize') {
    send({ result: { protocolVersion: 1, agentCapabilities: ${JSON.stringify(advertise ? { sessionCapabilities: { systemPrompt: agentLabel === 'claude-agent-acp' ? { mode: { override: {} } } : {} } } : {})} } });
  } else if (method === 'session/new') {
    // codex-acp 2.3.0 and claude-agent-acp 0.97.0 now validate this field.
    // This is the exact refusal for Beeline's old string-valued request.
    if (${advertise} && typeof params.systemPrompt === 'string') {
      send({ error: { code: -32602, message: 'Invalid params', data: {
        _errors: [], systemPrompt: { _errors: ['Invalid input: expected object, received string'] }
      } } });
      return;
    }
    send({ result: { sessionId: 'session-1', received: params } });
  }
});
`,
  );
  return new AcpClient({
    agentCommand: process.execPath,
    agentArgs: [script],
    agentLabel,
    agentEnv: {},
    resourceScope: 'none',
  });
}

describe('ACP session system prompt', () => {
  it.each(['codex-acp', 'claude-agent-acp'])(
    'uses advertised structured append content for %s (ACP-SYSTEM-PROMPT)',
    async (agentLabel) => {
      const client = await systemPromptAgent(true, agentLabel);
      try {
        await client.start();
        const session = await client.sessionNew({
          cwd: tmpdir(),
          systemPrompt: 'Beeline session instructions',
        });
        expect(session.raw).toMatchObject({
          received: {
            systemPrompt: {
              mode: 'append',
              content: [{ type: 'text', text: 'Beeline session instructions' }],
            },
          },
        });
      } finally {
        await client.stop();
      }
    },
  );

  it.each(['codex-acp', 'claude-agent-acp'])(
    'preserves the legacy prompt for %s without the capability',
    async (agentLabel) => {
      const client = await systemPromptAgent(false, agentLabel);
      try {
        await client.start();
        const session = await client.sessionNew({
          cwd: tmpdir(),
          systemPrompt: 'Legacy instructions',
        });
        expect(session.raw).toMatchObject({ received: { systemPrompt: 'Legacy instructions' } });
        if (agentLabel === 'claude-agent-acp') {
          expect(session.raw).toMatchObject({
            received: { _meta: { systemPrompt: { append: 'Legacy instructions' } } },
          });
        }
      } finally {
        await client.stop();
      }
    },
  );

  it('omits the optional prompt for a catalog probe', async () => {
    const client = await systemPromptAgent(true);
    try {
      await client.start();
      const session = await client.sessionNew({ cwd: tmpdir() });
      expect((session.raw as { received: object }).received).not.toHaveProperty('systemPrompt');
    } finally {
      await client.stop();
    }
  });
});
