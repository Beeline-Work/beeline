import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeEmptyTurn, type PromptResult } from './acp.js';
import { explainEmptyAgentTurn, isAccountOrProviderRefusal } from './empty-turn.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function result(updates: Array<Record<string, unknown>>, stopReason = 'end_turn'): PromptResult {
  return {
    stopReason,
    agentText: '',
    toolCalls: [],
    updates: updates.map((update) => ({ sessionId: 's', update })),
  };
}

describe('describeEmptyTurn', () => {
  it('names an empty stream', () => {
    expect(
      describeEmptyTurn(
        result([{ sessionUpdate: 'session_info_update', _meta: { piAcp: { running: true } } }]),
      ),
    ).toBe(
      'harness ended the turn (end_turn) with no answer text; the stream carried no content updates',
    );
  });
  it('names a reasoning-only or tool-only stream by its update kinds', () => {
    expect(
      describeEmptyTurn(
        result([
          { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
          { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
          { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read' },
        ]),
      ),
    ).toBe(
      'harness ended the turn (end_turn) with no answer text; the stream carried only agent_thought_chunk×2, tool_call×1',
    );
  });
  it('quotes retry narration that was the only message', () => {
    expect(
      describeEmptyTurn(
        result([
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Retrying (attempt 3/3, waiting 8s)...' },
          },
        ]),
        '/usr/bin/pi-acp',
      ),
    ).toBe(
      'harness ended the turn (end_turn) with no answer text; the stream carried only agent_message_chunk×1; the last message was retry narration "Retrying (attempt 3/3, waiting 8s)..."',
    );
  });
});

describe('explainEmptyAgentTurn', () => {
  it('uses the stream fact for a harness that is not pi-acp', async () => {
    const explained = await explainEmptyAgentTurn({
      agentLabel: '/usr/bin/codex-acp',
      agentEnv: {},
      sessionId: 's',
      result: result([]),
    });
    expect(explained).toEqual({
      reason:
        'harness ended the turn (end_turn) with no answer text; the stream carried no content updates',
    });
  });

  it("surfaces pi's recorded provider refusal and recovers recorded text", async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-empty-turn-'));
    roots.push(root);
    const piDir = join(root, 'pi');
    const sessions = join(piDir, 'sessions', 'p');
    await mkdir(sessions, { recursive: true });
    const write = (id: string, message: Record<string, unknown>) =>
      writeFile(
        join(sessions, `2026_${id}.jsonl`),
        [
          JSON.stringify({ type: 'message', message: { role: 'user', content: [] } }),
          JSON.stringify({ type: 'message', message: { role: 'assistant', ...message } }),
        ].join('\n'),
      );
    await write('refused', { content: [], stopReason: 'error', errorMessage: '402: no credits' });
    await write('answered', { content: [{ type: 'text', text: 'READY' }], stopReason: 'stop' });
    const agentEnv = { HOME: join(root, 'user'), PI_CODING_AGENT_DIR: piDir };
    const refused = await explainEmptyAgentTurn({
      agentLabel: '/opt/bin/pi-acp',
      agentEnv,
      sessionId: 'refused',
      result: result([]),
    });
    expect(refused.reason).toBe('provider error 402: no credits');
    expect(isAccountOrProviderRefusal(refused.record)).toBe(true);
    const answered = await explainEmptyAgentTurn({
      agentLabel: '/opt/bin/pi-acp',
      agentEnv,
      sessionId: 'answered',
      result: result([]),
    });
    expect(answered.recoveredText).toBe('READY');
    const unknown = await explainEmptyAgentTurn({
      agentLabel: '/opt/bin/pi-acp',
      agentEnv,
      sessionId: 'never-recorded',
      result: result([]),
    });
    expect(unknown.reason).toBe(
      'pi left no readable turn record; harness ended the turn (end_turn) with no answer text; the stream carried no content updates',
    );
  });

  it('classifies only account/provider-owned HTTP refusals as the model’s own answer', () => {
    for (const status of [401, 402, 403, 407, 408, 429, 500, 502, 529]) {
      expect(isAccountOrProviderRefusal({ kind: 'error', reason: 'x', status })).toBe(true);
    }
    for (const status of [400, 404, 422]) {
      expect(isAccountOrProviderRefusal({ kind: 'error', reason: 'x', status })).toBe(false);
    }
    expect(isAccountOrProviderRefusal({ kind: 'error', reason: 'fetch failed' })).toBe(false);
    expect(isAccountOrProviderRefusal({ kind: 'empty', stopReason: 'stop' })).toBe(false);
    expect(isAccountOrProviderRefusal(undefined)).toBe(false);
  });
});
