import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readWorkflowContract, workflowContentsError, workflowReceiptError, workflowSaveError } from './workflow-contracts.js';

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
      on: { pushed: 'checks', stuck: 'ask_human' },
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
  it('accepts the committed feedback-triage contract: notify, pull, approve gate, dispatch, done', () => {
    const feedbackTriage = JSON.parse(
      readFileSync(new URL('../../../docs/workflows/feedback-triage.json', import.meta.url), 'utf8'),
    );
    const read = readWorkflowContract(feedbackTriage);
    expect(read).toEqual(feedbackTriage);
    expect(read!.start).toBe('notify');
    expect(read!.handoffs.approve).toMatchObject({ kind: 'gate', on: { dispatch: 'dispatch', skip: 'done' } });
    // Dispatch is reachable only through the gate.
    for (const [name, state] of Object.entries(read!.handoffs))
      if (name !== 'approve' && 'on' in state && state.on)
        expect(Object.values(state.on), name).not.toContain('dispatch');
  });

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
    const implement = { ...contract.handoffs.implement, on: { pushed: 'checks', stuck: 'checks' } };
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
    const implement = { ...contract.handoffs.implement, on: { pushed: 'nowhere', stuck: 'ask_human' } };
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

describe('server and waiting states, implicit edges', () => {
  const base = {
    version: 1,
    name: 'corner',
    description: 'Corner lifecycle',
    roles: ['implementer', 'reviewer'],
    start: 'opened',
    handoffs: {
      opened: { kind: 'server', requires: [], on: { code: 'implement' } },
      implement: { role: 'implementer', requires: ['summary'], on: { pushed: 'checks' } },
      checks: {
        kind: 'server',
        requires: [],
        on: { passing: 'review', failing: 'implement' },
        loop: { onEdge: 'failing', cap: 5, onExceeded: 'ask_human' },
      },
      review: {
        kind: 'server',
        role: 'reviewer',
        requires: [],
        on: { approved: 'land', changes_requested: 'implement' },
        loop: { onEdge: 'changes_requested', cap: 3, onExceeded: 'ask_human' },
      },
      ask_human: { kind: 'waiting' },
      land: { role: 'implementer', requires: [], on: { merged: 'landed' } },
      landed: { kind: 'terminal', status: 'done' },
      closed: { kind: 'terminal', status: 'failed' },
    },
    implicitEdges: ['closed', 'landed'],
  } as const;

  it('accepts a server-kind state with no role', () => {
    expect(readWorkflowContract(base)).toEqual(base);
  });

  it('accepts a server-kind state with an advisory role', () => {
    expect(readWorkflowContract(base)?.handoffs.review).toEqual(base.handoffs.review);
  });

  it('rejects a server-kind state whose advisory role is unknown', () => {
    const review = { ...base.handoffs.review, role: 'ghost' };
    expect(
      readWorkflowContract({ ...base, handoffs: { ...base.handoffs, review } }),
    ).toBeNull();
  });

  it('accepts a waiting state reached only via implicitEdges, not as an on-target', () => {
    // ask_human above is never named by any `on` edge, only implicitly
    // reachable — the contract must still validate.
    expect(readWorkflowContract(base)).not.toBeNull();
  });

  it('accepts a waiting state carrying an advisory role', () => {
    const ask_human = { kind: 'waiting', role: 'implementer' };
    expect(
      readWorkflowContract({ ...base, handoffs: { ...base.handoffs, ask_human } }),
    ).not.toBeNull();
  });

  it('rejects a waiting state whose advisory role is unknown', () => {
    const ask_human = { kind: 'waiting', role: 'ghost' };
    expect(
      readWorkflowContract({ ...base, handoffs: { ...base.handoffs, ask_human } }),
    ).toBeNull();
  });

  it('rejects a waiting state carrying an unrecognized key', () => {
    const ask_human = { kind: 'waiting', requires: [] };
    expect(
      readWorkflowContract({ ...base, handoffs: { ...base.handoffs, ask_human } }),
    ).toBeNull();
  });

  it('rejects an implicitEdges entry naming a non-terminal state', () => {
    expect(
      readWorkflowContract({ ...base, implicitEdges: ['implement'] }),
    ).toBeNull();
  });

  it('rejects an implicitEdges entry naming a state that does not exist', () => {
    expect(readWorkflowContract({ ...base, implicitEdges: ['nowhere'] })).toBeNull();
  });

  it('accepts a server-kind loop with a capped onEdge', () => {
    const contract = readWorkflowContract(base);
    expect(contract?.handoffs.checks).toEqual(base.handoffs.checks);
  });

  it('a target reachable only through implicitEdges is not an orphan', () => {
    // "closed" has no ordinary `on` edge pointing to it anywhere in `base`.
    const hasOrdinaryEdge = Object.values(base.handoffs).some(
      (state) => 'on' in state && Object.values(state.on).includes('closed'),
    );
    expect(hasOrdinaryEdge).toBe(false);
    expect(readWorkflowContract(base)).not.toBeNull();
  });

  it('accepts an ordinary handoff state with a live roleBinding', () => {
    const { kind: _kind, ...rest } = base.handoffs.review;
    const review = { ...rest, roleBinding: 'live:parent.reviewer_agent_id' };
    const contract = { ...base, handoffs: { ...base.handoffs, review } };
    expect(readWorkflowContract(contract)?.handoffs.review).toEqual(review);
  });

  it('rejects a malformed roleBinding', () => {
    const { kind: _kind, ...rest } = base.handoffs.review;
    const review = { ...rest, roleBinding: 'parent.reviewer_agent_id' };
    expect(
      readWorkflowContract({ ...base, handoffs: { ...base.handoffs, review } }),
    ).toBeNull();
  });

  it('rejects a roleBinding on a server-kind state', () => {
    const checks = { ...base.handoffs.checks, roleBinding: 'live:parent.reviewer_agent_id' };
    expect(
      readWorkflowContract({ ...base, handoffs: { ...base.handoffs, checks } }),
    ).toBeNull();
  });

  it('accepts a terminal state with status abandoned', () => {
    const closed = { kind: 'terminal', status: 'abandoned' };
    const contract = { ...base, handoffs: { ...base.handoffs, closed } };
    expect(readWorkflowContract(contract)?.handoffs.closed).toEqual(closed);
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

  it('lists every missing required field in one refusal', () => {
    expect(workflowContentsError(state, {})).toBe('summary is required; prUrl is required');
    expect(workflowContentsError(state, { summary: null })).toBe('summary is required; prUrl is required');
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


describe('workflow summaries, hints and receipts', () => {
  it('keeps legacy definitions valid and permits 140 Unicode characters', () => {
    expect(readWorkflowContract(contract)).toEqual(contract);
    expect(readWorkflowContract({ ...contract, summary: 'x'.repeat(140) })).not.toBeNull();
    expect(readWorkflowContract({ ...contract, summary: '🌱'.repeat(140) })).not.toBeNull();
    expect(readWorkflowContract({ ...contract, summary: 'x'.repeat(141) })).toBeNull();
    expect(readWorkflowContract({ ...contract, summary: 'two\nlines' })).toBeNull();
    expect(readWorkflowContract({ ...contract, summary: null })).toBeNull();
  });

  it('allows optional free-text hints on every state kind', () => {
    const handoffs = Object.fromEntries(Object.entries(contract.handoffs).map(([name, state]) =>
      [name, { ...state, hint: 'the enduring artifact' }]));
    expect(readWorkflowContract({ ...contract, handoffs })).not.toBeNull();
    expect(readWorkflowContract({ ...contract, handoffs: {
      ...handoffs, implement: { ...handoffs.implement, hint: 3 },
    } })).toBeNull();
  });

  it('accepts missing/empty receipts and 140-character lines; rejects overlong or multiline lines', () => {
    for (const receipt of [undefined, {}, { line: '', refs: [] }, { line: 'x'.repeat(140) }, { line: '🌱'.repeat(140) }])
      expect(workflowReceiptError(receipt)).toBeNull();
    for (const receipt of [null, { line: 'x'.repeat(141) }, { line: 'two\nlines' }, { exit: { gate: 'fake', actorId: 'fake' } }])
      expect(workflowReceiptError(receipt)).not.toBeNull();
  });

  it('bounds typed references and rejects unknown kinds and unsafe links', () => {
    const ref = { kind: 'brief', label: 'Implementation brief', url: 'https://beeline.test/brief' };
    expect(workflowReceiptError({ refs: [ref, { ...ref, kind: 'pr' }, { ...ref, kind: 'checks' }] })).toBeNull();
    for (const refs of [[ref, ref, ref, ref], [{ ...ref, kind: 'custom' }], [{ ...ref, url: 'javascript:alert(1)' }], [{ ...ref, label: '' }]])
      expect(workflowReceiptError({ refs })).not.toBeNull();
  });
});

describe('human descriptions at the save boundary', () => {
  const described = { ...contract, summary: 'Build and review the agreed change.',
    handoffs: Object.fromEntries(Object.entries(contract.handoffs).map(([name, state]) =>
      [name, { ...state, does: `Perform ${name.replace(/_/g, ' ')}.` }])) };
  it('accepts new descriptions while reading legacy pinned contracts', () => {
    expect(workflowSaveError(described)).toBeNull();
    expect(readWorkflowContract(contract)).not.toBeNull();
    expect(workflowSaveError(contract)).toContain('summary');
  });
  it.each([undefined, '', '  ', 'x'.repeat(141), 'a\nb', 'a\rb', 'a\u2028b', 'a\u2029b'])('rejects invalid summary or does: %j', (text) => {
    expect(workflowSaveError({ ...described, summary: text })).not.toBeNull();
    expect(workflowSaveError({ ...described, handoffs: { ...described.handoffs,
      implement: { ...described.handoffs.implement, does: text } } })).not.toBeNull();
  });
  it('counts Unicode characters consistently at 140', () => {
    expect(workflowSaveError({ ...described, summary: '🦊'.repeat(140) })).toBeNull();
  });
});

describe('self-healing contract keys', () => {
  const described = { ...contract, summary: 'Build and review the agreed change.',
    handoffs: Object.fromEntries(Object.entries(contract.handoffs).map(([name, state]) =>
      [name, { ...state, does: `Perform ${name.replace(/_/g, ' ')}.` }])) };
  const withGate = (gate: Record<string, unknown>) => ({ ...described, handoffs: { ...described.handoffs,
    human_approve: { ...described.handoffs.human_approve, ...gate } } });

  it('accepts a gate timeout with a default, and a run deadline', () => {
    expect(workflowSaveError(withGate({ timeoutSeconds: 3600, default: 'rejected' }))).toBeNull();
    expect(workflowSaveError({ ...described, deadlineSeconds: 86400 })).toBeNull();
  });

  it('requires a gate timeout and default together, the default to be an outcome, and a deadline in range', () => {
    expect(workflowSaveError(withGate({ timeoutSeconds: 3600 }))).toContain('together');
    expect(workflowSaveError(withGate({ default: 'rejected' }))).toContain('together');
    expect(workflowSaveError(withGate({ timeoutSeconds: 3600, default: 'later' }))).toContain('is not an outcome in on');
    expect(workflowSaveError(withGate({ timeoutSeconds: 10, default: 'rejected' }))).toContain('timeoutSeconds must be');
    expect(workflowSaveError({ ...described, deadlineSeconds: 30 })).toContain('deadlineSeconds must be');
  });

  it('reserves blocked on new saves but still reads a pinned version that declares it', () => {
    const declared = { ...described, handoffs: { ...described.handoffs,
      implement: { ...described.handoffs.implement, on: { pushed: 'checks', blocked: 'ask_human' } } } };
    expect(workflowSaveError(declared)).toContain('"blocked" is built in');
    expect(readWorkflowContract(declared)).not.toBeNull();
  });
});
