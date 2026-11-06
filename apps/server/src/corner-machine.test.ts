import { describe, expect, it } from 'vitest';
import {
  transitionCorner,
  type CornerMachine,
  type CornerMachineFacts,
  type CornerEvent,
} from './corner-lifecycle.js';

const head = 'a'.repeat(40);
const pr = {
  number: 7,
  headSha: head,
  url: 'https://github.com/o/r/pull/7',
  title: 'Change',
  targetBranch: 'main',
};
const idle: CornerMachine = { state: 'idle' };
const facts: CornerMachineFacts = { archived: false, turnRunning: false };
const green: CornerMachineFacts = {
  ...facts,
  headSha: head,
  reviewerConfigured: true,
  lifecycle: { lifecycle: 'in-review', checks: 'passing', pr },
};
const observe: CornerEvent = { kind: 'reconcile' };
const run = (f: CornerMachineFacts, event: CornerEvent = observe, current: CornerMachine = idle) =>
  transitionCorner(current, { facts: f, event });

describe('corner transition table', () => {
  it.each([
    ['scratch open', facts, { kind: 'open' }, 'idle', undefined],
    ['worker executing', { ...facts, turnRunning: true }, observe, 'working', undefined],
    ['worker ends without PR', { ...facts, idleSince: '1', idleEligible: true }, observe, 'idle', undefined],
    ['push after handoff', { ...green, lifecycle: { ...green.lifecycle!, checks: 'pending' } }, { kind: 'push', headSha: head, contents: {} }, 'review', undefined],
    ['first failing job', { ...green, lifecycle: { ...green.lifecycle!, checks: 'failing' }, checkSourceId: 'red' }, { kind: 'checks', result: 'failing', sourceMessageId: 'red' }, 'working', 'checks-failed'],
    ['all green', green, observe, 'review', 'review'],
    ['corner/Room reviewer already running', { ...green, reviewerActive: true }, observe, 'review', undefined],
    ['review requests changes', { ...green, reviewEnded: { id: 'review', findings: 'FAIL: missing test' } }, observe, 'working', 'review-findings'],
    ['review ends without verdict', { ...green, reviewEnded: { id: 'review' } }, observe, 'working', 'review-no-verdict'],
    ['no reviewer', { ...green, reviewerConfigured: false }, observe, 'review', 'review-gap'],
    ['yes before green continues landing', { ...green, approved: true }, observe, 'working', 'land'],
    ['landing refusal', green, { kind: 'merge-refused', headSha: head, reason: 'base moved' }, 'working', 'merge-refused'],
    ['PR closes unmerged', facts, { kind: 'pull-request-closed', number: 7 }, 'idle', undefined],
    ['confirmed merge', green, { kind: 'merged', contents: {} }, 'archived', undefined],
    ['authorized close', facts, { kind: 'closed' }, 'archived', undefined],
  ] as const)('%s', (_label, f, event, state, wake) => {
    const result = run(f, event);
    expect(result.state.state).toBe(state);
    if (wake) expect(result.wakes.map((effect) => effect.kind)).toContain(wake);
    else expect(result.wakes).toEqual([]);
  });
  it('opens assigned work once with its original command provenance', () => {
    const event: CornerEvent = {
      kind: 'open',
      command: {
        roomId: 'corner',
        agentId: 'worker',
        sourceMessageId: null,
        reason: 'corner_objective',
      },
    };
    const first = run(facts, event);
    expect(first.wakes.map((wake) => wake.kind)).toEqual(['open']);
    expect(
      run(facts, event, { state: 'working', effects: first.wakes.map((w) => w.key) }).wakes,
    ).toEqual([]);
  });
  it.each(['question', 'approve', 'connect'] as const)(
    'an explicit %s wait stays visible during worker, reviewer and CI activity',
    (reason) => {
      const result = run({
        ...green,
        turnRunning: true,
        reviewerActive: true,
        lifecycle: { ...green.lifecycle!, checks: 'pending' },
        blocker: { reason, itemId: 'ask' },
      });
      expect(result.state).toMatchObject({
        state: 'waiting',
        reason: reason === 'question' ? 'question' : 'user_action',
      });
      expect(result.notifications.map((n) => n.kind)).toEqual(['waiting']);
      expect(run({ ...facts, turnRunning: true }, observe, result.state).state.state).toBe(
        'working',
      );
    },
  );
  it('does not let a merge hold stop implementing', () => {
    expect(
      run({
        ...facts,
        turnRunning: true,
        blocker: { reason: 'approve', blocker: { kind: 'merge-hold' } },
      }).state.state,
    ).toBe('working');
  });
  it('notifies the commander for one idle episode', () => {
    const f = { ...facts, idleEligible: true, idleSince: '123.456' };
    const first = run(f);
    expect(first.notifications).toEqual([{ kind: 'idle', key: 'idle:123.456' }]);
    expect(run(f, observe, { ...first.state, effects: ['idle:123.456'] }).notifications).toEqual(
      [],
    );
  });
  it('hands back findings and missing verdicts once per exact review', () => {
    for (const findings of [undefined, 'FAIL: attach evidence']) {
      const f = { ...green, reviewEnded: { id: 'review', findings } };
      const first = run(f);
      expect(first.wakes).toHaveLength(1);
      expect(run(f, observe, { ...first.state, effects: [first.wakes[0]!.key] }).wakes).toEqual([]);
    }
  });
  it('repairs a lost failed-check wake without repeating a retained command', () => {
    const red = { ...green, lifecycle: { ...green.lifecycle!, checks: 'failing' as const }, checkSourceId: 'red' };
    const first = run(red);
    const delivered = { ...first.state, effects: [first.wakes[0]!.key] };
    expect(run({ ...red, checkDelivered: true }, observe, delivered).wakes).toEqual([]);
    expect(run({ ...red, checkDelivered: false }, observe, delivered).wakes.map(wake => wake.kind))
      .toEqual(['checks-failed']);
  });
  it('rejects old-head and duplicate check deliveries', () => {
    expect(
      run(green, { kind: 'checks', result: 'failing', sourceMessageId: 'old' }).suppression,
    ).toBe('stale check event');
    expect(
      run(
        { ...green, checkSourceId: 'stale' },
        { kind: 'checks', result: 'passing', sourceMessageId: 'old' },
      ).suppression,
    ).toBe('stale check event');
  });
  it('keeps archived terminal and discards old-head receipts on a new head', () => {
    expect(run(green, observe, { state: 'archived' }).state.state).toBe('archived');
    const old: CornerMachine = {
      state: 'working',
      headSha: 'old',
      effects: [`review-gap:${head}`],
    };
    expect(run({ ...green, reviewerConfigured: false }, observe, old).wakes[0]?.kind).toBe(
      'review-gap',
    );
  });
});
