import { describe, expect, it } from 'vitest';
import { readWorkflowDefinition, workflowOutputError } from './workflows.js';

const definition = {
  version: 1,
  name: 'code-corner',
  roles: ['implementer', 'reviewer'],
  trigger: { kind: 'manual' },
  start: 'implement',
  states: {
    implement: {
      kind: 'step',
      step: {
        role: 'implementer',
        skill: 'implement-change',
        output: { pr_url: 'string', head_sha: 'string' },
        timeoutSeconds: 3600,
        retries: 1,
      },
      on: { success: 'wait_ci', failure: 'escalate', timeout: 'escalate' },
    },
    wait_ci: {
      kind: 'wait',
      event: 'ci_completed',
      timeoutSeconds: 7200,
      on: { success: 'review', timeout: 'escalate' },
    },
    review: {
      kind: 'step',
      step: {
        role: 'reviewer',
        skill: 'code-review',
        output: { verdict: { type: 'string', enum: ['approve', 'changes'] } },
        timeoutSeconds: 3600,
        retries: 1,
      },
      guard: { field: 'verdict' },
      on: { approve: 'closed', changes: 'implement', failure: 'escalate', timeout: 'escalate' },
      loop: { to: 'implement', maxIterations: 5, onExceeded: 'escalate' },
    },
    escalate: { kind: 'terminal' },
    closed: { kind: 'terminal' },
  },
} as const;

describe('workflow definition boundary', () => {
  it('accepts a versioned, bounded review loop', () => {
    expect(readWorkflowDefinition(definition)).toEqual(definition);
  });

  it('rejects an unbounded back edge', () => {
    const review = {
      ...definition.states.review,
      loop: undefined,
      on: { ...definition.states.review.on, changes: 'implement' },
    };
    expect(
      readWorkflowDefinition({ ...definition, states: { ...definition.states, review } }),
    ).toBeNull();
  });

  it('rejects unreachable states and unknown roles', () => {
    expect(
      readWorkflowDefinition({
        ...definition,
        states: { ...definition.states, orphan: { kind: 'terminal' } },
      }),
    ).toBeNull();
    expect(
      readWorkflowDefinition({
        ...definition,
        states: {
          ...definition.states,
          implement: {
            ...definition.states.implement,
            step: { ...definition.states.implement.step, role: 'stranger' },
          },
        },
      }),
    ).toBeNull();
  });

  it('rejects inherited object names as state targets', () => {
    expect(readWorkflowDefinition({ ...definition, start: 'toString' })).toBeNull();
    expect(readWorkflowDefinition({
      ...definition,
      states: {
        ...definition.states,
        implement: {
          ...definition.states.implement,
          on: { ...definition.states.implement.on, success: 'toString' },
        },
      },
    })).toBeNull();
    expect(readWorkflowDefinition({
      ...definition,
      states: {
        ...definition.states,
        review: { ...definition.states.review, loop: { ...definition.states.review.loop, to: 'constructor' } },
      },
    })).toBeNull();
  });

  it('validates cycles independent of outcome order', () => {
    const review = {
      ...definition.states.review,
      on: { approve: 'closed', failure: 'implement', changes: 'escalate', timeout: 'escalate' },
      loop: { ...definition.states.review.loop, to: 'implement' },
    };
    expect(readWorkflowDefinition({ ...definition, states: { ...definition.states, review } })).not.toBeNull();
    expect(readWorkflowDefinition({
      ...definition,
      states: { ...definition.states, review: { ...review, loop: undefined } },
    })).toBeNull();
  });

  it('bounds a wait failure edge back to implementation', () => {
    const wait = {
      ...definition.states.wait_ci,
      on: { success: 'review', failure: 'implement', timeout: 'escalate' },
      loop: { to: 'implement', maxIterations: 5, onExceeded: 'escalate' },
    };
    expect(readWorkflowDefinition({ ...definition, states: { ...definition.states, wait_ci: wait } })).not.toBeNull();
    expect(readWorkflowDefinition({
      ...definition,
      states: { ...definition.states, wait_ci: { ...wait, loop: undefined } },
    })).toBeNull();
  });

  it('checks structured output fields', () => {
    expect(
      workflowOutputError(definition.states.implement.step, {
        pr_url: 'https://example.test',
        head_sha: 'abc',
      }),
    ).toBeNull();
    expect(
      workflowOutputError(definition.states.implement.step, {
        pr_url: 'https://example.test',
        head_sha: 12,
      }),
    ).toBe('head_sha must be string');
  });

  it('requires an enum contract for a guard that chooses the next state', () => {
    const review = {
      ...definition.states.review,
      step: {
        ...definition.states.review.step,
        output: { verdict: { type: 'string', enum: ['approve', 'changes'] } },
      },
      guard: { field: 'verdict' },
      on: { approve: 'closed', changes: 'implement', failure: 'escalate', timeout: 'escalate' },
    };
    expect(
      readWorkflowDefinition({ ...definition, states: { ...definition.states, review } }),
    ).not.toBeNull();
    expect(workflowOutputError(review.step, { verdict: 'maybe' })).toBe(
      'verdict must be one of approve, changes',
    );
  });
});
