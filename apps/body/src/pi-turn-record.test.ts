import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPiTurnRecord, summarizeProviderError } from './pi-turn-record.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The exact `errorMessage` pi recorded for Candy's turns (2026-09-03), trimmed to one previous error. */
const OPENROUTER_402 =
  '402: {"message":"This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 10381. To increase, visit https://openrouter.ai/settings/credits and add more credits","code":402,"metadata":{"limit_source":"openrouter_credits","remedy_hint":"Add credits at https://openrouter.ai/settings/credits, or lower max_tokens / prompt size to fit your remaining balance.","provider_name":null,"previous_errors":[{"code":402,"message":"This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 20762. To increase, visit https://openrouter.ai/settings/credits and add more credits"}]}}';

const SESSION_ID = '01a06906-b018-7c0b-b173-a7db3ee866a5';

function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

const userTurn = line({
  type: 'message',
  id: 'f5dbf756',
  message: { role: 'user', content: [{ type: 'text', text: 'Reply READY.' }], timestamp: 1 },
});

function assistant(message: Record<string, unknown>): string {
  return line({
    type: 'message',
    id: '708f5975',
    message: {
      role: 'assistant',
      api: 'openai-completions',
      provider: 'openrouter',
      model: 'z-ai/glm-5.3-flash',
      timestamp: 2,
      ...message,
    },
  });
}

async function piHome(
  record: string,
  options: { map?: boolean } = {},
): Promise<{
  agentEnv: Record<string, string>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'beeline-pi-record-'));
  roots.push(root);
  const home = join(root, 'user');
  const piDir = join(root, 'pi');
  const sessionsDir = join(piDir, 'sessions', '--checkout--');
  await mkdir(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, `2026-09-03T20-47-21-112Z_${SESSION_ID}.jsonl`);
  await writeFile(
    sessionFile,
    line({ type: 'session', version: 3, id: SESSION_ID, cwd: '/checkout' }) +
      line({ type: 'model_change', provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash' }) +
      record,
  );
  if (options.map) {
    await mkdir(join(home, '.pi', 'pi-acp'), { recursive: true });
    await writeFile(
      join(home, '.pi', 'pi-acp', 'session-map.json'),
      JSON.stringify({
        version: 1,
        sessions: { [SESSION_ID]: { sessionId: SESSION_ID, cwd: '/checkout', sessionFile } },
      }),
    );
  }
  return { agentEnv: { HOME: home, PI_CODING_AGENT_DIR: piDir } };
}

describe('readPiTurnRecord', () => {
  it('names the provider refusal pi recorded for an assistant message with stopReason error', async () => {
    const { agentEnv } = await piHome(
      userTurn + assistant({ content: [], stopReason: 'error', errorMessage: OPENROUTER_402 }),
      { map: true },
    );
    const record = await readPiTurnRecord({ agentEnv, sessionId: SESSION_ID });
    expect(record).toEqual({
      kind: 'error',
      status: 402,
      reason:
        'provider error 402: This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 10381. To increase, visit https://openrouter.ai/settings/credits and add more credits',
    });
  });

  it("finds the session file through pi's own layout when pi-acp's map is absent", async () => {
    const { agentEnv } = await piHome(
      userTurn + assistant({ content: [], stopReason: 'error', errorMessage: '429: rate limited' }),
    );
    expect(await readPiTurnRecord({ agentEnv, sessionId: SESSION_ID })).toEqual({
      kind: 'error',
      status: 429,
      reason: 'provider error 429: rate limited',
    });
  });

  it('reports an assistant message that carries no text as empty with its stop reason', async () => {
    const { agentEnv } = await piHome(
      userTurn +
        assistant({ content: [{ type: 'thinking', thinking: 'hmm' }], stopReason: 'stop' }),
    );
    expect(await readPiTurnRecord({ agentEnv, sessionId: SESSION_ID })).toEqual({
      kind: 'empty',
      stopReason: 'stop',
    });
  });

  it('recovers answer text pi recorded for this turn', async () => {
    const { agentEnv } = await piHome(
      userTurn + assistant({ content: [{ type: 'text', text: 'READY' }], stopReason: 'stop' }),
    );
    expect(await readPiTurnRecord({ agentEnv, sessionId: SESSION_ID })).toEqual({
      kind: 'answer',
      text: 'READY',
    });
  });

  it('never attributes an earlier turn’s answer to a turn pi recorded no assistant message for', async () => {
    const { agentEnv } = await piHome(
      userTurn +
        assistant({ content: [{ type: 'text', text: 'earlier answer' }], stopReason: 'stop' }) +
        userTurn,
    );
    expect(await readPiTurnRecord({ agentEnv, sessionId: SESSION_ID })).toEqual({
      kind: 'missing',
    });
  });

  it('is undefined without a pi home, for an unknown session, or for a record without messages', async () => {
    expect(await readPiTurnRecord({ agentEnv: {}, sessionId: SESSION_ID })).toBeUndefined();
    const { agentEnv } = await piHome('');
    expect(await readPiTurnRecord({ agentEnv, sessionId: 'other-session' })).toBeUndefined();
    expect(await readPiTurnRecord({ agentEnv, sessionId: SESSION_ID })).toBeUndefined();
  });
});

describe('summarizeProviderError', () => {
  it('keeps the status and the human message out of a JSON body', () => {
    expect(summarizeProviderError('402: {"error":{"message":"insufficient credits"}}')).toEqual({
      status: 402,
      reason: 'provider error 402: insufficient credits',
    });
  });
  it('keeps a plain first line when there is no status', () => {
    expect(summarizeProviderError('fetch failed\n  at node:internal')).toEqual({
      reason: 'provider error: fetch failed',
    });
  });
});
