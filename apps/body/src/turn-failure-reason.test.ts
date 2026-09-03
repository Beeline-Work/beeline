import { describe, expect, it } from 'vitest';
import { distillTurnFailureReason, TURN_FAILURE_REASON_MAX } from './turn-failure-reason.js';

describe('distillTurnFailureReason', () => {
  it('keeps one line of the harness error and drops the stack', () => {
    const error = new Error('ACP error -32000: provider error 429 concurrency_limit');
    error.stack = `${error.message}\n    at AcpClient.request (/opt/beeline/acp.js:984:20)\n    at async prompt (/opt/beeline/turn.js:1:1)`;
    expect(distillTurnFailureReason(error)).toBe(
      'provider error 429 concurrency_limit'.replace(/^/, 'ACP error -32000: '),
    );
    expect(distillTurnFailureReason(error)).not.toMatch(/\n|\bat\s/);
  });

  it('takes the first informative line of a multi-line message and strips the Error: prefix', () => {
    expect(
      distillTurnFailureReason(
        new Error('\nTypeError: ACP session timed out after 120000ms of inactivity\n    at x'),
      ),
    ).toBe('ACP session timed out after 120000ms of inactivity');
    expect(distillTurnFailureReason('ACP agent exited (code 1)')).toBe('ACP agent exited (code 1)');
    expect(distillTurnFailureReason({ message: 'exit 137' })).toBe('exit 137');
    expect(distillTurnFailureReason(undefined)).toBe('turn failed');
    expect(distillTurnFailureReason(new Error('   '))).toBe('turn failed');
  });

  it('scrubs credentials before the reason leaves the daemon', () => {
    const reason = distillTurnFailureReason(
      new Error(
        '401 from https://openrouter.ai Authorization: Bearer sk-or-v1-abcdefghijklmnop api_key=sk-live-1234567890abcdef ghp_abcdefghijklmnopqrstuvwxyz',
      ),
    );
    expect(reason).not.toMatch(/sk-or-v1|sk-live|ghp_abc/);
    expect(reason).toContain('[REDACTED]');
  });

  it(`caps the line at ${TURN_FAILURE_REASON_MAX} characters`, () => {
    const reason = distillTurnFailureReason(new Error('x'.repeat(1_000)));
    expect(reason).toHaveLength(TURN_FAILURE_REASON_MAX);
    expect(reason.endsWith('…')).toBe(true);
  });
});
