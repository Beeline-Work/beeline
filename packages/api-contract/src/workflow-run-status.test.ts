import { describe, expect, it } from 'vitest';
import { workflowRunStatus, workflowStepDisplayStatus } from './workflow-run-status.js';
import type { WorkflowContract } from './workflow-contracts.js';

const contract: WorkflowContract = {
  version: 1, name: 'check', description: 'Check work', roles: ['worker'], start: 'work',
  handoffs: {
    work: { role: 'worker', requires: [], on: { done: 'done', failed: 'failed' } },
    done: { kind: 'terminal', status: 'done' },
    failed: { kind: 'terminal', status: 'failed' },
    abandoned: { kind: 'terminal', status: 'abandoned' },
  },
};

describe('workflow run display status', () => {
  it('lets deadline failure and cancellation close a nonterminal state', () => {
    expect(workflowRunStatus(contract, 'work', 'failed')).toBe('failed');
    expect(workflowRunStatus(contract, 'work', 'abandoned')).toBe('abandoned');
    expect(workflowStepDisplayStatus(contract, 'work', 'failed', false)).toBe('failed');
    expect(workflowStepDisplayStatus(contract, 'work', 'abandoned', false)).toBe('done');
  });

  it('keeps only the last live visit current and preserves earlier completed visits', () => {
    expect(workflowRunStatus(contract, 'work')).toBe('live');
    expect(workflowStepDisplayStatus(contract, 'work', 'live', false)).toBe('current');
    for (const status of ['live', 'done', 'failed', 'abandoned'] as const) {
      expect(workflowStepDisplayStatus(contract, 'work', status, true)).toBe('done');
    }
  });

  it('uses the definition for legacy terminal cards, and keeps failed terminals failed', () => {
    for (const status of ['done', 'failed', 'abandoned'] as const) {
      expect(workflowRunStatus(contract, status)).toBe(status);
      expect(workflowStepDisplayStatus(contract, status, status, false)).toBe(status === 'done' ? 'done' : 'failed');
    }
    expect(workflowRunStatus(contract, 'done', 'failed')).toBe('failed');
  });
});
