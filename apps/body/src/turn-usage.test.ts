import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHarnessTurnUsage, TurnUsageAccumulator } from './turn-usage.js';

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
      totalInputTokens: 2_120 + 88_832, modelCalls: 1, modelCallsWithoutUsage: 0,
      model: 'z-ai/glm-5.3-flash',
    });
  });

  it('reads only the latest turn and leaves totals absent when usage is missing', async () => {
    const agentEnv = await agentEnvFor(
      user('First question') +
        assistant({ input: 500, cacheRead: 4_000, cacheWrite: 0 }) +
        user('Second question') +
        assistant(undefined),
    );
    await expect(readHarnessTurnUsage({ agentEnv, sessionId: SESSION_ID })).resolves.toEqual({
      model: 'z-ai/glm-5.3-flash',
      modelCalls: 0,
      modelCallsWithoutUsage: 1,
    });

    const partial = await agentEnvFor(
      user('Only question') + assistant({ input: 10, cacheRead: 0, cacheWrite: 5 }),
    );
    await expect(
      readHarnessTurnUsage({ agentEnv: partial, sessionId: SESSION_ID }),
    ).resolves.toEqual({
      inputTokens: 15,
      totalInputTokens: 15,
      modelCalls: 1,
      modelCallsWithoutUsage: 0,
      model: 'z-ai/glm-5.3-flash',
    });
  });

  it('Reproduction H-11: sums three assistant calls while retaining final-call input', async () => {
    const agentEnv = await agentEnvFor(
      user('work') + assistant({ input: 10 }) + assistant({ input: 20 }) + assistant({ input: 30 }),
    );
    expect(await readHarnessTurnUsage({ agentEnv, sessionId: SESSION_ID })).toMatchObject({
      inputTokens: 30,
      totalInputTokens: 60,
      modelCalls: 3,
      modelCallsWithoutUsage: 0,
    });
  });

  it('counts iterations, nudges and new repair sessions without history or duplicate calls', async () => {
    const agentEnv = await agentEnvFor(user('history') + assistant({ input: 999 }));
    const { piSessionFilePath } = await import('./pi-turn-record.js');
    const file = (await piSessionFilePath(agentEnv, SESSION_ID))!;
    const { appendFile } = await import('node:fs/promises');
    const total = new TurnUsageAccumulator();
    await total.measure({ agentEnv, sessionId: SESSION_ID }, async () => {
      await appendFile(file, user('work') + assistant({ input: 10 }) + assistant({ input: 20 }));
    });
    await total.measure({ agentEnv, sessionId: SESSION_ID }, async () => {
      await appendFile(file, user('nudge') + assistant(undefined));
    });
    expect(total.usage).toEqual({ model: 'z-ai/glm-5.3-flash', totalInputTokens: 30, modelCalls: 2, modelCallsWithoutUsage: 1 });
    const repaired = await agentEnvFor(user('old') + assistant({ input: 888 }));
    const repairFile = (await piSessionFilePath(repaired, SESSION_ID))!;
    await expect(
      total.measure({ agentEnv: repaired, sessionId: SESSION_ID }, async () => {
        await appendFile(repairFile, user('retry') + assistant({ input: 30, cacheRead: 5 }));
        throw new Error('provider failed after recording usage');
      }),
    ).rejects.toThrow('provider failed');
    await total.measure({ agentEnv: repaired, sessionId: SESSION_ID }, async () => undefined);
    expect(total.usage).toMatchObject({
      inputTokens: 35,
      totalInputTokens: 65,
      modelCalls: 3,
      modelCallsWithoutUsage: 1,
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
