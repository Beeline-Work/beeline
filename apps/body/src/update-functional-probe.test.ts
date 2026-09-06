import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodyConfig } from './config.js';
import {
  probeOutcome,
  runUpdateFunctionalProbe,
  UpdateFunctionalProbeError,
  type ProbeAppeal,
} from './update-functional-probe.js';

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
  'refused-404': { role: 'assistant', content: [], stopReason: 'error', errorMessage: '404: {"message":"No endpoints found that can handle the requested parameters."}' },
  'empty': { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }], stopReason: 'stop' },
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'probe-session' } });
  } else if (message.method === 'session/prompt') {
    // Neither shape leaves pi a turn record: the failure is the ACP answer.
    if (behavior === 'rpc-internal' || behavior === 'rpc-invalid-params') {
      const code = behavior === 'rpc-internal' ? -32603 : -32602;
      const text = behavior === 'rpc-internal' ? 'Internal error' : 'Invalid params';
      send({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
      return;
    }
    // Never answers, and streams nothing: the prompt's inactivity timer fires.
    if (behavior === 'silent') return;
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

async function probe(
  behavior: string,
  extra: Partial<Parameters<typeof runUpdateFunctionalProbe>[0]> = {},
) {
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
    ...extra,
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
    expect((error as Error).message).toBe(
      'functional update probe failed (turn-failed): the harness completed a session/prompt without an agent answer: provider error 400: invalid provider routing',
    );
    expect((error as UpdateFunctionalProbeError).providerRefusal).toEqual({
      status: 400,
      reason: 'provider error 400: invalid provider routing',
    });
  });

  describe('compared with the current release', () => {
    const refusal404 =
      'provider error 404: No endpoints found that can handle the requested parameters.';

    it('passes, logged, when the current release gets the identical provider refusal', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const compared: ProbeAppeal[] = [];
      // The "current release" is the same fake harness refused with the same 404.
      await expect(
        probe('refused-404', {
          compareWithCurrentRelease: async (appeal) => {
            compared.push(appeal);
            return probeOutcome(() => probe('refused-404'));
          },
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          turnCompleted: true,
          modelAnswer: 'unavailable',
          modelAnswerReason: `${refusal404} (the current release gets the same 404)`,
        }),
      );
      expect(compared).toEqual([
        {
          kind: 'provider-refusal',
          reason: refusal404,
          refusal: { status: 404, reason: refusal404 },
        },
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('the provider refused this release and the current release alike'),
      );
    });

    it('still fails when the current release answers', async () => {
      const error = await probe('refused-404', {
        compareWithCurrentRelease: async () => probeOutcome(() => probe('served')),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UpdateFunctionalProbeError);
      expect((error as Error).message).toContain(`${refusal404}; the current release answered`);
      expect((error as UpdateFunctionalProbeError).providerRefusal?.status).toBe(404);
    });

    it('still fails when the current release is refused differently', async () => {
      const error = await probe('refused-404', {
        compareWithCurrentRelease: async () => probeOutcome(() => probe('refused-400')),
      }).catch((caught: unknown) => caught);
      expect((error as Error).message).toContain(
        'the current release got a different refusal (provider error 400: invalid provider routing)',
      );
    });

    it('still fails when the current release cannot be compared', async () => {
      const error = await probe('refused-404', {
        compareWithCurrentRelease: async () => ({
          kind: 'unavailable',
          reason: 'release old printed no probe report (exit 1)',
        }),
      }).catch((caught: unknown) => caught);
      expect((error as Error).message).toContain(
        'the current release could not be compared (release old printed no probe report (exit 1))',
      );
    });

    it('never compares an account-side refusal or a status-less failure', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const compare = vi.fn(async () => ({ kind: 'served' }) as const);
      await expect(probe('refused-402', { compareWithCurrentRelease: compare })).resolves.toEqual(
        expect.objectContaining({ modelAnswer: 'unavailable' }),
      );
      await expect(probe('no-record', { compareWithCurrentRelease: compare })).rejects.toThrow(
        'pi left no readable turn record',
      );
      expect(compare).not.toHaveBeenCalled();
    });
  });

  /**
   * 2026-09-06 (v0.0.51): every helper rolled a sound bundle back. Codex-harness
   * helpers logged `functional update probe failed (turn-failed): ACP error
   * -32603: Internal error` with the account out of credits; pi/GLM helpers
   * logged `functional update probe failed (turn-failed): ACP session/prompt
   * timed out after 45000ms of inactivity` while OpenRouter threw 429s. Neither
   * shape carries a status, so neither reached the refusal appeal above.
   */
  describe('an ACP-level failure of the probe turn', () => {
    it('passes, logged, when the current release fails with the same internal error', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const compared: ProbeAppeal[] = [];
      await expect(
        probe('rpc-internal', {
          compareWithCurrentRelease: async (appeal) => {
            compared.push(appeal);
            return probeOutcome(() => probe('rpc-internal'));
          },
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          sessionStarted: true,
          turnCompleted: false,
          modelAnswer: 'unavailable',
          modelAnswerReason:
            'ACP error -32603: Internal error (the current release fails the same way)',
        }),
      );
      expect(compared).toEqual([
        {
          kind: 'acp-turn-failure',
          reason: 'ACP error -32603: Internal error',
          failure: { kind: 'server-internal', code: -32603 },
        },
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('the probe turn failed the same way on this release'),
      );
    });

    it('still fails when the current release serves the same turn', async () => {
      const error = await probe('rpc-internal', {
        compareWithCurrentRelease: async () => probeOutcome(() => probe('served')),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UpdateFunctionalProbeError);
      expect((error as UpdateFunctionalProbeError).reason).toBe('turn-failed');
      expect((error as Error).message).toBe(
        'functional update probe failed (turn-failed): ACP error -32603: Internal error; ' +
          'the current release answered',
      );
    });

    it('passes when the prompt times out on inactivity for the current release too', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const result = await probe('silent', {
        turnTimeoutMs: 1_000,
        compareWithCurrentRelease: async () =>
          probeOutcome(() => probe('silent', { turnTimeoutMs: 1_000 })),
      });
      expect(result).toMatchObject({ turnCompleted: false, modelAnswer: 'unavailable' });
      expect(result.modelAnswerReason).toContain(
        'ACP session/prompt timed out after 1000ms of inactivity',
      );
      expect(result.modelAnswerReason).toContain('(the current release fails the same way)');
    }, 30_000);

    it('still fails when the current release fails some other way', async () => {
      const error = await probe('silent', {
        turnTimeoutMs: 1_000,
        compareWithCurrentRelease: async () => probeOutcome(() => probe('refused-404')),
      }).catch((caught: unknown) => caught);
      expect((error as Error).message).toContain(
        'the current release got a different refusal (provider error 404',
      );
    }, 30_000);

    it('never appeals a JSON-RPC code only a bad bundle produces', async () => {
      const compare = vi.fn(async () => ({ kind: 'served' }) as const);
      const error = await probe('rpc-invalid-params', {
        compareWithCurrentRelease: compare,
      }).catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(
        'functional update probe failed (turn-failed): ACP error -32602: Invalid params',
      );
      expect(compare).not.toHaveBeenCalled();
    });
  });

  it('fails, named, when the turn ends empty and pi left no record', async () => {
    const error = await probe('no-record').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpdateFunctionalProbeError);
    expect((error as Error).message).toContain(
      'pi left no readable turn record; harness ended the turn (end_turn) with no answer text; the stream carried no content updates',
    );
  });
});
