import { describe, expect, it } from 'vitest';
import {
  completedModelSpend,
  dailyAgentSpend,
  dailyRestartReprimes,
  failedModelSpend,
  formatAgentSpendReport,
  formatReprimeReport,
  reportedTokenUsage,
  type ModelTurnSpend,
} from './model-spend.js';

describe('model spend accounting', () => {
  it('uses cumulative adapter-reported tokens without double-counting streaming snapshots', () => {
    expect(
      reportedTokenUsage([
        {
          sessionId: 's',
          update: { sessionUpdate: 'usage_update', usage: { input_tokens: 80, output_tokens: 10 } },
        },
        {
          sessionId: 's',
          update: { sessionUpdate: 'usage_update', usage: { input_tokens: 80, output_tokens: 25 } },
        },
      ]),
    ).toEqual({ input: 80, output: 25 });
  });

  it('falls back to an explicitly-labelled estimate and counts each tool call once', () => {
    const spend = completedModelSpend({
      result: {
        stopReason: 'end_turn',
        agentText: 'done',
        toolCalls: [],
        updates: [
          { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'one' } },
          { sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'one' } },
        ],
      },
      prompt: '12345678',
      systemPromptChars: 12,
      attribution: {
        cause: 'restart-continuation',
        requestId: 'resume',
        originalRequestId: 'human',
      },
      agentPubkey: 'agent-a',
      channelId: 'corner',
      startedAt: '2026-08-20T12:00:00.000Z',
    });
    expect(spend).toMatchObject({
      inputTokens: 5,
      outputTokens: 1,
      totalTokens: 6,
      tokenSource: 'estimated',
      toolCalls: 1,
      originalRequestId: 'human',
    });
  });

  it('groups calls per agent and day while retaining the causal turn list', () => {
    const base: ModelTurnSpend = {
      agentPubkey: 'agent-a',
      channelId: 'room',
      requestId: 'request-1',
      originalRequestId: 'request-1',
      cause: 'room-message',
      startedAt: '2026-08-20T12:00:00.000Z',
      status: 'complete',
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      tokenSource: 'reported',
      toolCalls: 1,
    };
    const failed = failedModelSpend({
      prompt: 'retry',
      systemPromptChars: 3,
      attribution: {
        cause: 'restart-continuation',
        requestId: 'request-1',
        originalRequestId: 'request-1',
      },
      agentPubkey: 'agent-a',
      channelId: 'corner',
      startedAt: '2026-08-20T13:00:00.000Z',
      error: new Error('offline'),
    });
    const report = dailyAgentSpend(
      [failed, base, { ...base, agentPubkey: 'agent-b', startedAt: '2026-08-19T23:59:59.000Z' }],
      '2026-08-20',
    );
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({
      agentPubkey: 'agent-a',
      calls: 2,
      reportedCalls: 1,
      estimatedCalls: 1,
      toolCalls: 1,
    });
    expect(report[0]!.turns.map((turn) => turn.cause)).toEqual([
      'room-message',
      'restart-continuation',
    ]);
    expect(formatAgentSpendReport(report)).toContain('agent=agent-a calls=2 tokens=');
    expect(formatAgentSpendReport(report)).toContain(
      'restart-continuation status=failed tokens=~2 tools=0 request=request-1 original=request-1',
    );
  });

  it('attributes Atlas → Scout work to each executing provider while retaining one root principal', () => {
    const result = {
      stopReason: 'end_turn',
      agentText: 'done',
      toolCalls: [],
      updates: [],
    };
    const root = 'human-root';
    const principal = 'owner-pubkey';
    const atlas = completedModelSpend({
      result,
      prompt: 'coordinate',
      systemPromptChars: 0,
      attribution: {
        cause: 'room-message',
        requestId: root,
        originalRequestId: root,
        trigger: 'human',
        rootEventId: root,
        principalPubkey: principal,
      },
      agentPubkey: 'atlas',
      channelId: 'room',
      startedAt: '2026-08-20T12:00:00.000Z',
    });
    const scout = completedModelSpend({
      result,
      prompt: 'research',
      systemPromptChars: 0,
      attribution: {
        cause: 'delegation',
        requestId: 'delegation-turn',
        originalRequestId: root,
        trigger: 'delegation',
        rootEventId: root,
        principalPubkey: principal,
        commissionedByAgentPubkey: 'atlas',
        delegationId: 'graph',
        workItemId: 'work',
        reservedTokens: 2_000,
      },
      agentPubkey: 'scout',
      channelId: 'room',
      startedAt: '2026-08-20T12:01:00.000Z',
    });
    expect(atlas).toMatchObject({
      chargedAgentPubkey: 'atlas',
      rootEventId: root,
      principalPubkey: principal,
    });
    expect(scout).toMatchObject({
      chargedAgentPubkey: 'scout',
      commissionedByAgentPubkey: 'atlas',
      rootEventId: root,
      principalPubkey: principal,
      delegationId: 'graph',
      workItemId: 'work',
      reservedTokens: 2_000,
    });
  });

  it('measures re-prime size and count per daemon process generation', () => {
    const reports = dailyRestartReprimes(
      [
        {
          agentPubkey: 'agent-a',
          channelId: 'room-1',
          processGeneration: 'pid-start',
          at: '2026-08-20T12:00:00.000Z',
          entries: 200,
          beforeChars: 114_000,
          afterChars: 8_000,
          beforeTokens: 28_500,
          afterTokens: 2_000,
        },
        {
          agentPubkey: 'agent-a',
          channelId: 'room-2',
          processGeneration: 'pid-start',
          at: '2026-08-20T12:01:00.000Z',
          entries: 6,
          beforeChars: 1_700,
          afterChars: 1_700,
          beforeTokens: 425,
          afterTokens: 425,
        },
      ],
      '2026-08-20',
    );
    expect(reports[0]).toMatchObject({ count: 2, beforeTokens: 28_925, afterTokens: 2_425 });
    expect(formatReprimeReport(reports)).toContain(
      'restart=pid-start re-primes=2 before=28925 after=2425 tokens',
    );
  });
});
