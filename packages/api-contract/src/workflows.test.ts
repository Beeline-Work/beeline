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
        output: { verdict: 'string' },
        timeoutSeconds: 3600,
        retries: 1,
      },
      on: { success: 'closed', failure: 'escalate', timeout: 'escalate' },
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
});
