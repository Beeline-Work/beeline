import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodyConfig } from './config.js';
import { runUpdateFunctionalProbe, UpdateFunctionalProbeError } from './update-functional-probe.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A pi-acp-shaped harness: it always answers `session/prompt` with
 * `end_turn`, and what it does before that is chosen by FAKE_PI_BEHAVIOR —
 * stream READY, or stream nothing while writing the turn record pi itself
 * would write into $PI_CODING_AGENT_DIR (`pi-turn-record.ts`).
 */
async function fakePiAcp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'beeline-fake-pi-acp-'));
  roots.push(dir);
  const binary = join(dir, 'pi-acp');
  await writeFile(
    binary,
    `#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const behavior = process.env.FAKE_PI_BEHAVIOR;
const records = {
  'refused-402': { role: 'assistant', content: [], stopReason: 'error', errorMessage: '402: {"message":"This request requires more credits, or fewer max_tokens."}' },
  'refused-400': { role: 'assistant', content: [], stopReason: 'error', errorMessage: '400: {"message":"invalid provider routing"}' },
  'empty': { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }], stopReason: 'stop' },
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'probe-session' } });
  } else if (message.method === 'session/prompt') {
    if (behavior === 'served') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'probe-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'READY' } } } });
    } else if (records[behavior]) {
      const dir = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', 'probe');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, '2026_probe-session.jsonl'),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }) + '\\n' +
          JSON.stringify({ type: 'message', message: records[behavior] }) + '\\n',
      );
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

async function probe(behavior: string) {
  const command = await fakePiAcp();
  const root = await mkdtemp(join(tmpdir(), 'beeline-probe-'));
  roots.push(root);
  const operatorHome = join(root, 'operator-home');
  await mkdir(operatorHome, { recursive: true });
  const config = {
    agentBinary: command,
    agentKind: 'pi',
    agentCommand: command,
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
    readonlyMcpCommand: '/fake-beeline-mcp',
    agentEnv: { PATH: process.env.PATH ?? '', FAKE_PI_BEHAVIOR: behavior },
    workspaceRoot: join(root, 'workspace'),
    autoApprovePermissions: true,
    accessPolicy: 'everyone',
    operatorHome,
    sharedSkills: [],
  } as unknown as BodyConfig;
  return runUpdateFunctionalProbe({
    config,
    runtimeDir: join(root, 'runtime'),
    releaseId: 'release-1',
    sandboxRequired: false,
    sessionTimeoutMs: 10_000,
    turnTimeoutMs: 10_000,
  });
}

describe('runUpdateFunctionalProbe', () => {
  it('passes with a served answer', async () => {
    await expect(probe('served')).resolves.toEqual(
      expect.objectContaining({ harness: 'pi', turnCompleted: true, modelAnswer: 'served' }),
    );
  });

  it("passes with the reason logged when pi's record shows an account-side refusal", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(probe('refused-402')).resolves.toEqual(
      expect.objectContaining({
        turnCompleted: true,
        modelAnswer: 'unavailable',
        modelAnswerReason:
          'provider error 402: This request requires more credits, or fewer max_tokens.',
      }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider error 402'));
  });

  it('passes when the model itself answered with no text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(probe('empty')).resolves.toEqual(
      expect.objectContaining({
        modelAnswer: 'unavailable',
        modelAnswerReason: 'the model ended its turn with no text (stop reason stop)',
      }),
    );
  });

  it('fails, named, on a refusal a bundle could have caused', async () => {
    const error = await probe('refused-400').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpdateFunctionalProbeError);
    expect((error as UpdateFunctionalProbeError).reason).toBe('turn-failed');
    expect((error as Error).message).toContain('provider error 400: invalid provider routing');
  });

  it('fails, named, when the turn ends empty and pi left no record', async () => {
    const error = await probe('no-record').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpdateFunctionalProbeError);
    expect((error as Error).message).toContain(
      'pi left no readable turn record; harness ended the turn (end_turn) with no answer text; the stream carried no content updates',
    );
  });
});
