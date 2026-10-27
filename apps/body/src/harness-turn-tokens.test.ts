import { describe, expect, it } from 'vitest';
import { harnessTurnTokens, mergeHarnessTurnMetrics } from './harness-turn-tokens.js';

describe('harness turn tokens', () => {
  it('adds Claude cache traffic to uncached input and keeps explicit zeros', () => {
    expect(
      harnessTurnTokens({
        stopReason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 7,
        },
      }),
    ).toEqual({ inputTokens: 117, outputTokens: 4 });
    expect(
      harnessTurnTokens({ usage: { input_tokens: 0, output_tokens: 0 } }),
    ).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('does not add Codex cached input, which is already inside input_tokens', () => {
    expect(
      harnessTurnTokens({
        stopReason: 'end_turn',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 80,
          output_tokens: 20,
          reasoning_output_tokens: 5,
        },
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('reads ACP usage, including a copy nested under _meta', () => {
    expect(
      harnessTurnTokens({
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 4, cachedReadTokens: 30, cachedWriteTokens: 2 },
      }),
    ).toEqual({ inputTokens: 42, outputTokens: 4 });
    expect(
      harnessTurnTokens({ _meta: { usage: { prompt_tokens: 8, completion_tokens: 3 } } }),
    ).toEqual({ inputTokens: 8, outputTokens: 3 });
  });

  it('keeps one running total and sums separate calls', () => {
    const update = (usage: Record<string, number>) => ({ update: { sessionUpdate: 'usage_update', usage } });
    expect(
      harnessTurnTokens({ stopReason: 'end_turn' }, [
        update({ input_tokens: 10, output_tokens: 1 }),
        update({ input_tokens: 25, output_tokens: 4 }),
      ]),
    ).toEqual({ inputTokens: 25, outputTokens: 4 });
    expect(
      harnessTurnTokens(undefined, [
        update({ input_tokens: 10, output_tokens: 5 }),
        update({ input_tokens: 3, output_tokens: 1 }),
      ]),
    ).toEqual({ inputTokens: 13, outputTokens: 6 });
  });

  it('ignores a context-window update and leaves an unreported turn unknown', () => {
    expect(harnessTurnTokens({ stopReason: 'end_turn' }, [{ update: { used: 100, size: 200 } }])).toBeUndefined();
    expect(harnessTurnTokens({ stopReason: 'end_turn' })).toBeUndefined();
    expect(harnessTurnTokens({ usage: { input_tokens: 1.5, output_tokens: -4 } })).toBeUndefined();
  });

  it('lets pi figures stand and fills only the sides pi did not report', () => {
    expect(
      mergeHarnessTurnMetrics(
        { inputTokens: 30, totalInputTokens: 60, totalOutputTokens: 12, modelCalls: 3, modelCallsWithoutUsage: 0 },
        { inputTokens: 999, outputTokens: 999 },
      ),
    ).toEqual({
      inputTokens: 30,
      totalInputTokens: 60,
      outputTokens: 12,
      modelCalls: 3,
      modelCallsWithoutUsage: 0,
    });
    expect(mergeHarnessTurnMetrics(undefined, { inputTokens: 5, outputTokens: 2 }, 40)).toEqual({
      inputTokens: 5,
      totalInputTokens: 5,
      outputTokens: 2,
      promptBytes: 40,
    });
    expect(mergeHarnessTurnMetrics({ modelCalls: 0, modelCallsWithoutUsage: 1 }, undefined)).toEqual({
      modelCalls: 0,
      modelCallsWithoutUsage: 1,
    });
  });
});
