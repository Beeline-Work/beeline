import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateCornerWorkflow, readWorkflowContract, workflowContentsError, workflowReceiptError, validateSavedWorkflow } from './workflow-contracts.js';

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

/** The test contract with what a new save needs: descriptions, step timeouts and gate defaults. */
function saveable(): typeof contract & { summary: string } {
  return { ...contract, summary: 'Build and review the agreed change.',
    handoffs: Object.fromEntries(Object.entries(contract.handoffs).map(([name, state]) => {
      const timed = !('kind' in state) ? { on: { ...state.on, timeout: 'failed' }, timeoutSeconds: 3600 }
        : state.kind === 'gate' ? { timeoutSeconds: 3600, default: Object.keys(state.on)[0] } : {};
      return [name, { ...state, ...timed, does: `Perform ${name.replace(/_/g, ' ')}.` }];
    })) } as typeof contract & { summary: string };
}

describe('human descriptions at the save boundary', () => {
  const described = saveable();
  it('accepts new descriptions while reading legacy pinned contracts', () => {
    expect(validateSavedWorkflow(described)).toBeNull();
    expect(readWorkflowContract(contract)).not.toBeNull();
    expect(validateSavedWorkflow(contract)).toContain('summary');
  });
  it.each([undefined, '', '  ', 'x'.repeat(141), 'a\nb', 'a\rb', 'a\u2028b', 'a\u2029b'])('rejects invalid summary or does: %j', (text) => {
    expect(validateSavedWorkflow({ ...described, summary: text })).not.toBeNull();
    expect(validateSavedWorkflow({ ...described, handoffs: { ...described.handoffs,
      implement: { ...described.handoffs.implement, does: text } } })).not.toBeNull();
  });
  it('counts Unicode characters consistently at 140', () => {
    expect(validateSavedWorkflow({ ...described, summary: '🦊'.repeat(140) })).toBeNull();
  });
});

describe('self-healing contract keys', () => {
  const described = saveable();
  const withGate = (gate: Record<string, unknown>) => ({ ...described, handoffs: { ...described.handoffs,
    human_approve: { ...described.handoffs.human_approve, ...gate } } });

  it('accepts a gate timeout with a default, and a run deadline', () => {
    expect(validateSavedWorkflow(withGate({ timeoutSeconds: 3600, default: 'rejected' }))).toBeNull();
    expect(validateSavedWorkflow({ ...described, deadlineSeconds: 86400 })).toBeNull();
  });

  it('requires a gate timeout and default together, the default to be an outcome, and a deadline in range', () => {
    expect(validateSavedWorkflow(withGate({ timeoutSeconds: 3600, default: undefined }))).toContain('together');
    expect(validateSavedWorkflow(withGate({ timeoutSeconds: undefined, default: 'rejected' }))).toContain('together');
    expect(validateSavedWorkflow(withGate({ timeoutSeconds: 3600, default: 'later' }))).toContain('is not an outcome in on');
    expect(validateSavedWorkflow(withGate({ timeoutSeconds: 10, default: 'rejected' }))).toContain('timeoutSeconds must be');
    expect(validateSavedWorkflow({ ...described, deadlineSeconds: 30 })).toContain('deadlineSeconds must be');
  });

  it('refuses a new save with an agent step that has no timeout, or a gate with no timeout and default', () => {
    const { timeoutSeconds: _t, ...untimed } = described.handoffs.review as Record<string, unknown>;
    expect(validateSavedWorkflow({ ...described, handoffs: { ...described.handoffs, review: untimed } }))
      .toBe('handoffs.review: timeoutSeconds is required, with a "timeout" outcome in on');
    const { timeoutSeconds: _g, default: _d, ...gate } = described.handoffs.ask_human as Record<string, unknown>;
    expect(validateSavedWorkflow({ ...described, handoffs: { ...described.handoffs, ask_human: gate } }))
      .toBe('handoffs.ask_human: a gate needs timeoutSeconds and default');
    // Older versions without them still read and run.
    expect(readWorkflowContract(contract)).not.toBeNull();
  });

  it('reserves blocked on new saves but still reads a pinned version that declares it', () => {
    const declared = { ...described, handoffs: { ...described.handoffs,
      implement: { ...described.handoffs.implement, on: { pushed: 'checks', blocked: 'ask_human', timeout: 'failed' } } } };
    expect(validateSavedWorkflow(declared)).toContain('"blocked" is built in');
    expect(readWorkflowContract(declared)).not.toBeNull();
  });
});


describe('separate saved and corner validators', () => {
  const base = {
    version: 1, name: 'split', description: 'Validator boundary', summary: 'Do the work.',
    roles: ['worker'], start: 'work', handoffs: {
      work: { role: 'worker', requires: [], on: { done: 'done', timeout: 'done' }, timeoutSeconds: 60, does: 'Work.' },
      done: { kind: 'terminal', status: 'done', does: 'Finish.' },
    },
  };
  const work = (fields: Record<string, unknown>) => ({ ...base, handoffs: {
    ...base.handoffs, work: { ...base.handoffs.work, ...fields },
  } });
  const gate = { kind: 'gate', default: 'done' };

  it.each([
    [{ ...base, implicitEdges: ['done'] }, 'implicitEdges is corner-only and cannot be saved in a workflow'],
    [{ ...base, externalOutcomes: ['done'] }, 'externalOutcomes is corner-only and cannot be saved in a workflow'],
    [{ ...base, handoffs: { ...base.handoffs, work: { kind: 'server', requires: [], on: { done: 'done' } } } }, 'handoffs.work: kind server is corner-only and cannot be saved in a workflow'],
    [{ ...base, implicitEdges: undefined }, 'implicitEdges is corner-only and cannot be saved in a workflow'],
    [{ ...base, handoffs: { work: { kind: 'waiting' }, done: base.handoffs.done }, implicitEdges: ['done'] },
      'implicitEdges is corner-only and cannot be saved in a workflow'],
    [work({ roleBinding: 'live:parent.reviewer_agent_id' }), 'handoffs.work: roleBinding is corner-only and cannot be saved in a workflow'],
    [{ ...base, summary: undefined }, 'summary is required and must be nonempty'],
    [work({ does: undefined }), 'handoffs.work: does is required and must be nonempty'],
    [work({ on: { blocked: 'done', timeout: 'done' } }), 'handoffs.work: "blocked" is built in; name this outcome something else'],
    [work({ timeoutSeconds: undefined }), 'handoffs.work: timeoutSeconds is required, with a "timeout" outcome in on'],
    [work({ kind: 'gate', timeoutSeconds: undefined }), 'handoffs.work: a gate needs timeoutSeconds and default'],
  ])('rejects only at the save boundary: %s', (value, message) => {
    expect(validateSavedWorkflow(value)).toBe(message);
    expect(validateCornerWorkflow(value)).toBeNull();
    expect(readWorkflowContract(value)).toEqual(value);
  });

  it('rejects waiting on save while accepting a reachable corner waiting state', () => {
    const value = { ...base, handoffs: { ...base.handoffs,
      work: { ...base.handoffs.work, on: { done: 'done', timeout: 'wait' } }, wait: { kind: 'waiting' },
    } };
    expect(validateSavedWorkflow(value)).toBe('handoffs.wait: kind waiting is corner-only and cannot be saved in a workflow');
    expect(validateCornerWorkflow(value)).toBeNull();
  });

  it.each([
    [null, 'contract must be a JSON object'],
    [{ ...base, extra: true }, 'unknown key "extra" at the top level'],
    [{ ...base, version: 2 }, 'version must be 1'],
    [{ ...base, name: 'Bad' }, 'name must be lowercase words joined by hyphens, at most 64 characters (got "Bad")'],
    [{ ...base, description: 1 }, 'description must be a string'],
    [{ ...base, description: '' }, 'description must be 1-60 characters (got 0)'],
    [{ ...base, summary: 'two\nlines' }, 'summary must be plaintext on one line, at most 140 characters'],
    [{ ...base, roles: [] }, 'roles must be 1-16 unique lowercase names (letters, digits, _ or -)'],
    [{ ...base, handoffs: null }, 'handoffs must be an object of named states'],
    [{ ...base, handoffs: {} }, 'handoffs must have 2-64 states (got 0)'],
    [{ ...base, start: 'missing' }, 'start must name a state in handoffs (got "missing")'],
    [{ ...base, deadlineSeconds: 1 }, 'deadlineSeconds must be a whole number from 60 to 2592000'],
    [{ ...base, handoffs: { ...base.handoffs, Bad: base.handoffs.done } }, 'handoffs: state name "Bad" must be lowercase letters, digits, _ or -'],
    [{ ...base, handoffs: { ...base.handoffs, work: null } }, 'handoffs.work must be an object'],
    [{ ...base, handoffs: { ...base.handoffs, done: { ...base.handoffs.done, extra: true } } },
      'handoffs.done: unknown key "extra" (a terminal allows kind, status, hint, does)'],
    [{ ...base, handoffs: { ...base.handoffs, done: { ...base.handoffs.done, status: 'unknown' } } },
      'handoffs.done: terminal status must be done, failed or abandoned'],
    [work({ extra: true }), 'handoffs.work: unknown key "extra" (a handoff allows role, roleBinding, requires, on, loop, timeoutSeconds, hint, does)'],
    [work({ ...gate, extra: true }), 'handoffs.work: unknown key "extra" (a gate allows kind, role, requires, on, timeoutSeconds, default, hint, does)'],
    [work({ ...gate, on: { done: 'done' } }), 'handoffs.work: a gate needs 2-4 outcomes (got 1)'],
    [work({ ...gate, on: { ['a'.repeat(33)]: 'done', timeout: 'done' } }),
      `handoffs.work: outcome "${'a'.repeat(33)}" is longer than 32 characters`],
    [{ ...base, handoffs: { work: base.handoffs.work, done: base.handoffs.work } }, 'at least one terminal state is required'],
    [work({ does: '' }), 'handoffs.work: does must be nonempty plaintext on one line, at most 140 characters'],
    [work({ hint: 1 }), 'handoffs.work: hint must be a string'],
    [work({ kind: 'unknown' }), 'handoffs.work: kind must be gate, server, terminal or waiting, or omitted for a handoff'],
    [work({ role: 'missing' }), 'handoffs.work: role "missing" is not in roles'],
    [work({ requires: ['duplicate', 'duplicate'] }), 'handoffs.work: requires must be a list of up to 32 unique field names'],
    [work({ on: null }), 'handoffs.work: on must be an object of outcome -> state'],
    [work({ on: {} }), 'handoffs.work: on needs 1-16 outcomes (got 0)'],
    [work({ on: { Bad: 'done' } }), 'handoffs.work: outcome "Bad" must be lowercase letters, digits, _ or -'],
    [work({ on: { done: 'missing' } }), 'handoffs.work: outcome "done" goes to "missing", which is not a state'],
    [work({ timeoutSeconds: 1 }), 'handoffs.work: timeoutSeconds must be a whole number from 60 to 2592000'],
    [work({ on: { done: 'done' } }), 'handoffs.work: timeoutSeconds needs a "timeout" outcome in on'],
    [work({ ...gate, default: undefined }), 'handoffs.work: a gate declares timeoutSeconds and default together, or neither'],
    [work({ ...gate, default: 'missing' }), 'handoffs.work: default "missing" is not an outcome in on'],
    [work({ loop: null }), 'handoffs.work: loop must be { onEdge, cap, onExceeded }'],
    [work({ loop: { onEdge: 'missing', cap: 1, onExceeded: 'done' } }), 'handoffs.work: loop.onEdge "missing" is not an outcome in on'],
    [work({ loop: { onEdge: 'done', cap: 101, onExceeded: 'done' } }), 'handoffs.work: loop.cap must be a whole number from 1 to 100'],
    [work({ loop: { onEdge: 'done', cap: 1, onExceeded: 'missing' } }), 'handoffs.work: loop.onExceeded "missing" is not a state'],
    [work({ loop: { onEdge: 'done', cap: 1, onExceeded: 'done' } }), 'handoffs.work: loop.onExceeded must differ from where loop.onEdge goes'],
    [{ ...base, start: 'done' }, 'start state "done" must not be a terminal'],
    [work({ on: { done: 'work', timeout: 'done' } }), 'cycle work -> work has no loop cap'],
    [{ ...base, handoffs: { ...base.handoffs, orphan: base.handoffs.done } }, 'state "orphan" is not reachable from start'],
  ])('preserves the shared rejection: %s', (value, message) => {
    expect(validateSavedWorkflow(value)).toBe(message);
    expect(validateCornerWorkflow(value)).toBe(message);
  });

  it.each([
    [{ kind: 'waiting', hint: 1 }, 'handoffs.wait: hint must be a string'],
    [{ kind: 'waiting', does: '' }, 'handoffs.wait: does must be nonempty plaintext on one line, at most 140 characters'],
  ])('checks metadata on corner-only states', (waiting, message) => {
    expect(validateCornerWorkflow({ ...base, handoffs: { ...base.handoffs,
      work: { ...base.handoffs.work, on: { done: 'done', timeout: 'wait' } }, wait: waiting,
    } })).toBe(message);
  });
  it.each([
    [{ ...base, externalOutcomes: ['Bad'] }, 'externalOutcomes must be up to 16 unique outcome names'],
    [{ ...base, externalOutcomes: ['missing'] }, 'externalOutcomes: "missing" is not an outcome of any state'],
    [{ ...base, implicitEdges: ['done', 'done'] }, 'implicitEdges must be a list of unique state names'],
    [{ ...base, implicitEdges: ['work'] }, 'implicitEdges: "work" is not a terminal state'],
    [work({ roleBinding: 'parent.worker' }), 'handoffs.work: roleBinding must look like live:parent.field'],
    [{ ...base, handoffs: { ...base.handoffs, work: { kind: 'server', extra: true } } },
      'handoffs.work: unknown key "extra" (a server state allows kind, role, requires, on, loop, hint, does)'],
    [{ ...base, handoffs: { ...base.handoffs, work: { kind: 'server', role: 'missing', requires: [], on: { done: 'done' } } } },
      'handoffs.work: role "missing" is not in roles'],
    [{ ...base, handoffs: { ...base.handoffs, work: { kind: 'waiting', role: 'missing' } } },
      'handoffs.work: role "missing" is not in roles'],
    [{ ...base, handoffs: { ...base.handoffs, work: { kind: 'waiting', extra: true } } },
      'handoffs.work: unknown key "extra" (a waiting state allows kind, role, hint, does)'],
  ])('preserves corner-specific rejection: %s', (value, message) => {
    expect(validateCornerWorkflow(value)).toBe(message);
    expect(validateSavedWorkflow(value)).toBe(message);
  });

});
