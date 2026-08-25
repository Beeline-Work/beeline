/**
 * Opt-in real-harness gate for the ACP streaming contract.
 *
 * Run with:
 *   cd apps/body
 *   BEELINE_REAL_HARNESS_STREAM_TEST=1 npx vitest \
 *     --config vitest.live.config.ts --run src/streaming-harness.live.test.ts
 *
 * This uses the operator's installed Grok Build and Goose credentials. It is
 * excluded from ordinary CI because both providers are metered and may be
 * logged out or quota-limited. The hermetic ACP and Body tests own the exact
 * publishing assertions; this gate proves the real adapters still emit the
 * standard `agent_message_chunk` family those assertions consume.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AcpClient, type SessionUpdate } from './acp.js';

const enabled = process.env.BEELINE_REAL_HARNESS_STREAM_TEST === '1';
const clients: AcpClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe.runIf(enabled)('real streaming harness adapters', () => {
  const cases = [
    { name: 'Grok Build', command: 'grok', args: ['agent', 'stdio'] },
    { name: 'Goose', command: 'goose', args: ['acp'] },
  ] as const;

  for (const harness of cases) {
    it(`${harness.name} emits stream chunks that collapse to one final message run`, async () => {
      const client = new AcpClient({
        agentCommand: harness.command,
        agentArgs: [...harness.args],
        agentEnv: { ...process.env },
        agentCwd: process.cwd(),
        autoApprovePermissions: false,
      });
      clients.push(client);
      const updates: SessionUpdate[] = [];
      client.on('session/update', (update) => updates.push(update));
      await client.start();
      const session = await client.sessionNew({
        cwd: process.cwd(),
        mcpServers: [],
        systemPrompt: 'Do not use tools. Answer directly and concisely.',
        mode: 'readonly',
      });

      const streamed: string[] = [];
      const result = await client.sessionPrompt(
        session.sessionId,
        'Give three very short progress sentences, then end with FINAL: PONG. Do not use tools.',
        180_000,
        (_delta, fullText) => streamed.push(fullText),
      );

      expect(updates.some((update) => update.update.sessionUpdate === 'agent_message_chunk')).toBe(
        true,
      );
      expect(streamed.length).toBeGreaterThan(0);
      expect(result.agentText.trim().length).toBeGreaterThan(0);
    }, 240_000);
  }
});

if (!enabled) {
  describe('real streaming harness adapters (prerequisites)', () => {
    it('SKIPPED — set BEELINE_REAL_HARNESS_STREAM_TEST=1 with Grok and Goose authenticated', () => {
      expect(enabled).toBe(false);
    });
  });
}
