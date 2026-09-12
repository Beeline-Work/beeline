import { describe, expect, it } from 'vitest';
import { ModelSelectionUnavailableError } from './model-config.js';
import { distillTurnFailureReason, TURN_FAILURE_REASON_MAX } from './turn-failure-reason.js';

describe('distillTurnFailureReason', () => {
  it('keeps one line of the harness error and drops the stack', () => {
    const error = new Error('ACP error -32000: provider error 429 concurrency_limit');
    error.stack = `${error.message}\n    at AcpClient.request (/opt/beeline/acp.js:984:20)\n    at async prompt (/opt/beeline/turn.js:1:1)`;
    expect(distillTurnFailureReason(error).text).toBe(
      'provider error 429 concurrency_limit'.replace(/^/, 'ACP error -32000: '),
    );
    expect(distillTurnFailureReason(error).text).not.toMatch(/\n|\bat\s/);
  });

  it('takes the first informative line of a multi-line message and strips the Error: prefix', () => {
    expect(
      distillTurnFailureReason(
        new Error('\nTypeError: ACP session timed out after 120000ms of inactivity\n    at x'),
      ),
    ).toEqual({ text: 'ACP session timed out after 120000ms of inactivity' });
    expect(distillTurnFailureReason('ACP agent exited (code 1)')).toEqual({
      text: 'ACP agent exited (code 1)',
    });
    expect(distillTurnFailureReason({ message: 'exit 137' })).toEqual({ text: 'exit 137' });
    expect(distillTurnFailureReason(undefined)).toEqual({ text: 'turn failed' });
    expect(distillTurnFailureReason(new Error('   '))).toEqual({ text: 'turn failed' });
  });

  it('classifies model selection unavailability without sending its id or advice', () => {
    const failure = distillTurnFailureReason(
      new ModelSelectionUnavailableError({
        label: 'model',
        value: 'claude-fable-5-1[1m]',
        reason: 'not-advertised',
      }),
    );
    expect(failure).toEqual({
      text: 'model selection unavailable',
      kind: 'model-selection-unavailable',
    });
    expect(JSON.stringify(failure)).not.toMatch(/claude-fable|catalog/i);
  });

  it('scrubs credentials before the reason leaves the daemon', () => {
    const reason = distillTurnFailureReason(
      new Error(
        '401 from https://openrouter.ai Authorization: Bearer sk-or-v1-abcdefghijklmnop api_key=sk-live-1234567890abcdef ghp_abcdefghijklmnopqrstuvwxyz',
      ),
    );
    expect(reason.text).not.toMatch(/sk-or-v1|sk-live|ghp_abc/);
    expect(reason.text).toContain('[REDACTED]');
  });

  it(`caps the line at ${TURN_FAILURE_REASON_MAX} characters`, () => {
    const reason = distillTurnFailureReason(new Error('x'.repeat(1_000)));
    expect(reason.text).toHaveLength(TURN_FAILURE_REASON_MAX);
    expect(reason.text.endsWith('…')).toBe(true);
  });
});
