import { describe, expect, it } from 'vitest';
import { readWorkflowContract, workflowContentsError } from './workflow-contracts.js';

const contract = {
  version: 1,
  name: 'corner',
  description: 'Implement, get checks green, get reviewed, and land a change',
  roles: ['implementer', 'reviewer', 'approver'],
  start: 'implement',
  handoffs: {
    implement: {
      role: 'implementer',
      requires: ['summary', 'prUrl'],
      on: { pushed: 'checks', blocked: 'ask_human' },
    },
    checks: {
      role: 'implementer',
      requires: ['headSha'],
      on: { passing: 'review', failing: 'implement' },
      loop: { onEdge: 'failing', cap: 10, onExceeded: 'ask_human' },
    },
    review: {
      role: 'reviewer',
      requires: ['verdict', 'notes'],
      on: { approved: 'human_approve', changes_requested: 'implement' },
      loop: { onEdge: 'changes_requested', cap: 3, onExceeded: 'ask_human' },
    },
    human_approve: {
      kind: 'gate',
      role: 'approver',
      requires: ['decision'],
      on: { approved: 'land', rejected: 'implement' },
    },
    ask_human: {
      kind: 'gate',
      role: 'approver',
      requires: ['decision'],
      on: { resume: 'implement', abandon: 'failed' },
    },
    land: { kind: 'terminal', status: 'done' },
    failed: { kind: 'terminal', status: 'failed' },
  },
} as const;

describe('workflow contract validation', () => {
  it('accepts the built-in Corner-shaped contract', () => {
    expect(readWorkflowContract(contract)).toEqual(contract);
  });

  it('rejects an uncapped loop', () => {
    const review = { ...contract.handoffs.review, loop: undefined };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, review } }),
    ).toBeNull();
  });

  it('rejects a loop whose onExceeded target does not exist', () => {
    const review = {
      ...contract.handoffs.review,
      loop: { onEdge: 'changes_requested', cap: 3, onExceeded: 'nowhere' },
    };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, review } }),
    ).toBeNull();
  });

  it('rejects a loop cap above the maximum', () => {
    const review = {
      ...contract.handoffs.review,
      loop: { onEdge: 'changes_requested', cap: 101, onExceeded: 'ask_human' },
    };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, review } }),
    ).toBeNull();
  });

  it('rejects an unbounded cycle with no loop declared', () => {
    const checks = {
      ...contract.handoffs.checks,
      loop: undefined,
      on: { passing: 'review', failing: 'implement' },
    };
    const implement = { ...contract.handoffs.implement, on: { pushed: 'checks', blocked: 'checks' } };
    // implement -> checks -> implement with no loop cap anywhere is a real cycle.
    expect(
      readWorkflowContract({
        ...contract,
        handoffs: { ...contract.handoffs, checks, implement },
      }),
    ).toBeNull();
  });

  it('rejects an unknown role', () => {
    const implement = { ...contract.handoffs.implement, role: 'ghost' };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, implement } }),
    ).toBeNull();
  });

  it('rejects a handoff naming a target state that does not exist', () => {
    const implement = { ...contract.handoffs.implement, on: { pushed: 'nowhere', blocked: 'ask_human' } };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, implement } }),
    ).toBeNull();
  });

  it('rejects an unreachable state', () => {
    const orphan = { role: 'implementer', requires: [], on: { done: 'land' } };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, orphan } }),
    ).toBeNull();
  });

  it('rejects a start state that is terminal', () => {
    expect(readWorkflowContract({ ...contract, start: 'land' })).toBeNull();
  });

  it('rejects zero terminal states', () => {
    const land = { role: 'implementer', requires: [], on: { done: 'ask_human' } };
    const failed = { role: 'implementer', requires: [], on: { done: 'ask_human' } };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, land, failed } }),
    ).toBeNull();
  });

  it('rejects a gate with fewer than two outcomes', () => {
    const human_approve = { ...contract.handoffs.human_approve, on: { approved: 'land' } };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, human_approve } }),
    ).toBeNull();
  });

  it('rejects a gate with more than four outcomes', () => {
    const human_approve = {
      ...contract.handoffs.human_approve,
      on: { a: 'land', b: 'implement', c: 'ask_human', d: 'checks', e: 'review' },
    };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, human_approve } }),
    ).toBeNull();
  });

  it('rejects a gate carrying a loop', () => {
    const human_approve = {
      ...contract.handoffs.human_approve,
      loop: { onEdge: 'rejected', cap: 2, onExceeded: 'ask_human' },
    };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, human_approve } }),
    ).toBeNull();
  });

  it('rejects a timeout with no matching timeout outcome', () => {
    const implement = { ...contract.handoffs.implement, timeoutSeconds: 3600 };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, implement } }),
    ).toBeNull();
  });

  it('accepts a timeout paired with a timeout outcome', () => {
    const implement = {
      ...contract.handoffs.implement,
      on: { ...contract.handoffs.implement.on, timeout: 'ask_human' },
      timeoutSeconds: 3600,
    };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, implement } }),
    ).not.toBeNull();
  });

  it('rejects a timeout on a gate', () => {
    const human_approve = { ...contract.handoffs.human_approve, timeoutSeconds: 3600 };
    expect(
      readWorkflowContract({ ...contract, handoffs: { ...contract.handoffs, human_approve } }),
    ).toBeNull();
  });

  it('rejects a duplicate role', () => {
    expect(
      readWorkflowContract({ ...contract, roles: ['implementer', 'implementer', 'approver'] }),
    ).toBeNull();
  });

  it('rejects an invalid contract name', () => {
    expect(readWorkflowContract({ ...contract, name: 'Corner_Workflow' })).toBeNull();
  });

  it('rejects an oversized description', () => {
    expect(readWorkflowContract({ ...contract, description: 'x'.repeat(61) })).toBeNull();
  });

  it('rejects a non-object value', () => {
    expect(readWorkflowContract('not a contract')).toBeNull();
    expect(readWorkflowContract(null)).toBeNull();
  });
});

describe('workflow contents validation', () => {
  const state = { requires: ['summary', 'prUrl'] };

  it('accepts contents satisfying every required field', () => {
    expect(workflowContentsError(state, { summary: 'did the thing', prUrl: 'https://x' })).toBeNull();
  });

  it('accepts contents with a camelCase required field name', () => {
    expect(workflowContentsError({ requires: ['headSha'] }, { headSha: 'abc123' })).toBeNull();
  });

  it('rejects contents missing a required field', () => {
    expect(workflowContentsError(state, { summary: 'did the thing' })).toBe('prUrl is required');
  });

  it('rejects contents that are not an object', () => {
    expect(workflowContentsError(state, 'nope')).toBe('contents must be an object');
    expect(workflowContentsError(state, null)).toBe('contents must be an object');
  });

  it('rejects oversized contents', () => {
    expect(
      workflowContentsError({ requires: [] }, { blob: 'x'.repeat(20_000) }),
    ).toBe('contents exceeds 16 KB');
  });
});
