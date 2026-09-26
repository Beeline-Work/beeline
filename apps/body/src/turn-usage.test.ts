import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHarnessTurnUsage } from './turn-usage.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const SESSION_ID = '01a06906-b018-7c0b-b173-a7db3ee866a5';

function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

function user(text: string): string {
  return line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
}

function assistant(usage: Record<string, unknown> | undefined, text = 'ok'): string {
  return line({
    type: 'message',
    message: {
      role: 'assistant',
      model: 'z-ai/glm-5.3-flash',
      content: [{ type: 'text', text }],
      ...(usage ? { usage } : {}),
    },
  });
}

async function agentEnvFor(record: string): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-turn-usage-'));
  roots.push(root);
  const home = join(root, 'user');
  const piDir = join(root, 'pi');
  const sessionsDir = join(piDir, 'sessions', '--checkout--');
  await mkdir(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, `2026-09-03T20-47-21-112Z_${SESSION_ID}.jsonl`);
  await writeFile(
    sessionFile,
    line({ type: 'session', version: 3, id: SESSION_ID, cwd: '/checkout' }) + record,
  );
  await mkdir(join(home, '.pi', 'pi-acp'), { recursive: true });
  await writeFile(
    join(home, '.pi', 'pi-acp', 'session-map.json'),
    JSON.stringify({ sessions: { [SESSION_ID]: { sessionFile } } }),
  );
  return { HOME: home, PI_CODING_AGENT_DIR: piDir };
}

describe('harness turn usage', () => {
  it('counts the whole prompt a provider billed for, not just its uncached part', async () => {
    const agentEnv = await agentEnvFor(
      user('Reply READY.') +
        assistant({
          input: 2_120,
          output: 99,
          cacheRead: 88_832,
          cacheWrite: 0,
          totalTokens: 91_051,
        }),
    );
    await expect(readHarnessTurnUsage({ agentEnv, sessionId: SESSION_ID })).resolves.toEqual({
      inputTokens: 2_120 + 88_832,
      model: 'z-ai/glm-5.3-flash',
    });
  });

  it('answers about the LATEST turn, and with nothing when pi recorded no usage', async () => {
    const agentEnv = await agentEnvFor(
      user('First question') +
        assistant({ input: 500, cacheRead: 4_000, cacheWrite: 0 }) +
        user('Second question') +
        assistant(undefined),
    );
    await expect(
      readHarnessTurnUsage({ agentEnv, sessionId: SESSION_ID }),
    ).resolves.toBeUndefined();

    const partial = await agentEnvFor(
      user('Only question') + assistant({ input: 10, cacheRead: 0, cacheWrite: 5 }),
    );
    await expect(
      readHarnessTurnUsage({ agentEnv: partial, sessionId: SESSION_ID }),
    ).resolves.toEqual({
      inputTokens: 15,
      model: 'z-ai/glm-5.3-flash',
    });
  });

  it('is unknown rather than zero when there is no pi session to read', async () => {
    await expect(
      readHarnessTurnUsage({
        agentEnv: { PI_CODING_AGENT_DIR: '/nonexistent' },
        sessionId: 'nope',
      }),
    ).resolves.toBeUndefined();
    await expect(
      readHarnessTurnUsage({ agentEnv: {}, sessionId: SESSION_ID }),
    ).resolves.toBeUndefined();
  });
});
