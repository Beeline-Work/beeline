import { describe, expect, it, vi } from 'vitest';
import { AuthorizeOrRequestKernel, mandateCovers, scopeContained } from './authorize-or-request.js';
import type { ReadMandateResult } from './agent-tool-contract.js';

const scope = {
  type: 'corner.open' as const,
  workspaceId: 'workspace',
  roomId: 'room',
  repositoryKey: 'github:1',
  targetRef: 'refs/heads/main',
};

function mandate(effect: 'allow' | 'approval_required' | 'deny'): ReadMandateResult {
  return {
    schema_version: 3,
    generation: { event_id: 'a'.repeat(64), generation: 7 },
    grants: [],
    defaults: [
      { action: 'corner.open', version: 1, effect },
      { action: 'corner.close', version: 1, effect: 'approval_required' },
      { action: 'artifact.deliver', version: 1, effect: 'allow' },
    ],
    blockers: [],
  };
}

describe('authorize_or_request', () => {
  it('executes once and returns the same canonical event for a model retry', async () => {
    const kernel = new AuthorizeOrRequestKernel();
    const execute = vi.fn(async () => ({ event_id: 'e'.repeat(64), result: { corner_id: 'c' } }));
    const requestApproval = vi.fn();
    const call = () =>
      kernel.authorizeOrRequest({
        action: 'corner.open',
        scope,
        dedupKey: 'agent:turn:objective',
        readMandate: async () => mandate('allow'),
        execute,
        requestApproval,
      });
    await expect(Promise.all([call(), call()])).resolves.toEqual([
      { status: 'executed', event_id: 'e'.repeat(64), result: { corner_id: 'c' } },
      { status: 'executed', event_id: 'e'.repeat(64), result: { corner_id: 'c' } },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('creates exactly one pending request for an uncovered action', async () => {
    const kernel = new AuthorizeOrRequestKernel();
    const requestApproval = vi.fn(async () => ({
      request_id: 'request',
      event_id: 'p'.repeat(64),
      message: 'Approval is pending.',
    }));
    const call = () =>
      kernel.authorizeOrRequest({
        action: 'corner.close',
        scope: { ...scope, type: 'corner.close', cornerId: 'corner', disposition: 'land' },
        dedupKey: 'agent:turn:close-objective',
        readMandate: async () => mandate('approval_required'),
        execute: vi.fn(),
        requestApproval,
      });
    await expect(Promise.all([call(), call()])).resolves.toEqual([
      {
        status: 'approval_pending',
        request_id: 'request',
        event_id: 'p'.repeat(64),
        message: 'Approval is pending.',
      },
      {
        status: 'approval_pending',
        request_id: 'request',
        event_id: 'p'.repeat(64),
        message: 'Approval is pending.',
      },
    ]);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('fails retryably when the signed generation changes before execution', async () => {
    const kernel = new AuthorizeOrRequestKernel();
    let reads = 0;
    const result = await kernel.authorizeOrRequest({
      action: 'corner.open',
      scope,
      dedupKey: 'generation-race',
      readMandate: async () => {
        const value = mandate('allow');
        if (reads++ > 0) value.generation.generation += 1;
        return value;
      },
      execute: vi.fn(),
      requestApproval: vi.fn(),
    });
    expect(result).toEqual({
      status: 'failed',
      code: 'mandate_generation_changed',
      retryable: true,
      message: 'Authority changed before execution. Retry against the current mandate.',
    });
  });

  it('contains schedule grants structurally by exact operation and schedule id', () => {
    const grant = {
      type: 'schedule.update' as const,
      workspaceId: 'workspace',
      roomId: 'room',
      scheduleId: 'daily-triage',
      repositoryKey: 'github:1',
      targetRef: 'refs/heads/main',
    };
    expect(scopeContained(grant, { ...grant })).toBe(true);
    expect(scopeContained(grant, { ...grant, scheduleId: 'other' })).toBe(false);
    expect(scopeContained(grant, { ...grant, type: 'schedule.run_now' })).toBe(false);
  });

  it('denies unknown action defaults and every blocked generation', () => {
    const value = mandate('allow');
    expect(
      mandateCovers(value, 'schedule.create', {
        type: 'schedule.create',
        workspaceId: 'workspace',
        roomId: 'room',
        scheduleId: 'daily-triage',
      }),
    ).toBe('deny');
    value.blockers.push({ code: 'membership', message: 'missing' });
    expect(mandateCovers(value, 'corner.open', scope)).toBe('deny');
  });
});
