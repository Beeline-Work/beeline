import { expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { CommandRefusalError, ExpectedRefusalError } from './command-refusal.js';
import { CornerVerdictRejectedError } from './corner-merge-approval.js';
import { captureServerError } from './sentry.js';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

it('Reproduction SENTRY-REFUSALS: shared capture excludes typed refusals and retains unknown failures', () => {
  for (const status of [400, 403, 404, 409, 410, 429] as const) {
    captureServerError(new CommandRefusalError('Expected refusal', status));
  }
  captureServerError(new ExpectedRefusalError('Expected legacy refusal'));
  captureServerError(new CornerVerdictRejectedError('STALE_HEAD', 'Review current head'));
  expect(Sentry.captureException).not.toHaveBeenCalled();
  for (const error of [new Error('Unexpected fault'), { status: 403 }, 'unknown failure']) {
    captureServerError(error);
    expect(Sentry.captureException).toHaveBeenLastCalledWith(error, expect.anything());
  }
});
