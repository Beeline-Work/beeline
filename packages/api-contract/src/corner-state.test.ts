
import { describe as move8_describe, expect as move8_expect, it as move8_it } from 'vitest';

import { deriveCornerState as move8_deriveCornerState, type CornerStateFacts as move8_CornerStateFacts } from "./corner-state.js";

import type { CornerLifecycleView as move8_CornerLifecycleView, CornerState as move8_CornerState } from "./phone-types.js";
import { describe as movedDescribe8 } from 'vitest';
movedDescribe8("corner-state.exhaustive.test.ts", () => {


const PR = {
  number: 1,
  url: 'https://github.com/o/r/pull/1',
  title: 'Fix',
  targetBranch: 'main',
  headSha: 'a'.repeat(40),
} as const;


type CheckShape = 'pending' | 'passing' | 'failing' | 'unknown' | 'unreported' | 'no-checks';

type Closure = 'none' | 'landed' | 'done' | 'abandoned' | 'merged';

type BlockerKind =
  | 'none'
  | 'human-approve'
  | 'human-connect'
  | 'human-question'
  | 'merge-hold'
  | 'agent'
  | 'human+agent';


const RUNS = [
  undefined,
  { state: 'landed' },
  { state: 'closed' },
  { state: 'ask_human' },
  { state: 'implement', outcome: 'failed' },
  { state: 'review' },
  { state: 'checks' },
] as const;


const CHECKS: readonly CheckShape[] = ['pending', 'passing', 'failing', 'unknown', 'unreported', 'no-checks'];

const BLOCKERS: readonly BlockerKind[] = [
  'none',
  'human-approve',
  'human-connect',
  'human-question',
  'merge-hold',
  'agent',
  'human+agent',
];


function lifecycleFor(shape: CheckShape, prPresent: boolean, closure: Closure): move8_CornerLifecycleView {
  const checks =
    shape === 'pending' ? 'pending' : shape === 'passing' ? 'passing' : shape === 'failing' ? 'failing' : 'unknown';
  let lifecycle: move8_CornerLifecycleView = {
    lifecycle: 'in-review',
    checks,
    ...(prPresent ? { pr: PR } : {}),
  };
  if (shape === 'unreported' || shape === 'no-checks') {
    lifecycle = {
      ...lifecycle,
      checks: 'unknown',
      checksSummary: {
        status: 'unknown',
        total: 0,
        failing: [],
        checks: [],
        updatedAt: 1,
        ...(shape === 'no-checks' ? { fetchStartedAt: 1 } : {}),
      },
    };
  }
  if (closure === 'landed') lifecycle = { ...lifecycle, outcome: 'landed' };
  if (closure === 'done') lifecycle = { ...lifecycle, lifecycle: 'done' };
  if (closure === 'abandoned') lifecycle = { ...lifecycle, outcome: 'abandoned' };
  if (closure === 'merged' && lifecycle.pr) {
    lifecycle = { ...lifecycle, pr: { ...lifecycle.pr, mergedAt: '2026-10-20T00:00:00.000Z' } };
  }
  return lifecycle;
}


function blockerFacts(kind: BlockerKind): Pick<move8_CornerStateFacts, 'blocker'> {
  if (kind === 'none') return {};
  if (kind === 'agent') {
    return {
      blocker: { reason: 'question', blocker: { kind: 'report', personId: 'commander' } },
    };
  }
  if (kind === 'merge-hold') {
    return {
      blocker: { reason: 'approve', blocker: { kind: 'merge-hold', personId: 'human' } },
    };
  }
  const reason = kind === 'human-approve' ? 'approve' : kind === 'human-connect' ? 'connect' : 'question';
  return {
    blocker: { reason, blocker: { kind: 'message', personId: 'human' } },
  };
}


function pendingOnHead(facts: move8_CornerStateFacts): boolean {
  const lifecycle = facts.lifecycle;
  const checks = lifecycle?.checksSummary?.status ?? lifecycle?.checks;
  const summary = lifecycle?.checksSummary;
  const unreported =
    Boolean(lifecycle?.pr) &&
    summary?.status === 'unknown' &&
    summary.total === 0 &&
    summary.fetchStartedAt === undefined;
  return checks === 'pending' || unreported;
}


function isClosed(facts: move8_CornerStateFacts): boolean {
  if (facts.archived) return true;
  if (facts.run?.state === 'landed' || facts.run?.state === 'closed') return true;
  const lifecycle = facts.lifecycle;
  const raw = String(lifecycle?.lifecycle ?? '').trim().toLowerCase();
  if (lifecycle?.pr?.mergedAt || lifecycle?.outcome === 'landed') return true;
  if (lifecycle?.outcome === 'abandoned') return true;
  if (raw === 'done') return true;
  return false;
}


function scan(
  failures: string[],
  closures: readonly Closure[],
): number {
  let count = 0;
  for (const archived of [false, true]) {
    for (const run of RUNS) {
      for (const closure of closures) {
        for (const turnRunning of [false, true]) {
            for (const locked of [false, true]) {
              for (const reviewerActive of [false, true]) {
                for (const shape of CHECKS) {
                  for (const prPresent of [false, true]) {
                    if (closure === 'merged' && !prPresent) continue;
                    for (const blocker of BLOCKERS) {
                      count += 1;
                      const facts: move8_CornerStateFacts = {
                        archived,
                        locked,
                        turnRunning,
                        reviewerActive,
                        ...(run ? { run } : {}),
                        lifecycle: lifecycleFor(shape, prPresent, closure),
                        ...blockerFacts(blocker),
                      };
                      const actual: move8_CornerState = move8_deriveCornerState(facts).state;
                      const closed = facts.archived || (!locked && isClosed(facts));
                      const pending = pendingOnHead(facts);
                      const anyBlocker = blocker !== 'none';
                      let expected: move8_CornerState;
                      if (closed) expected = 'archived';
                      else if (turnRunning) expected = 'working';
                      else if (reviewerActive || pending) expected = 'review';
                      else if (anyBlocker) expected = 'waiting';
                      else expected = 'idle';
                      if (actual !== expected && failures.length < 8) {
                        failures.push(
                          `got ${actual} expected ${expected} archived=${archived} run=${run?.state ?? '-'} closure=${closure} turn=${turnRunning} locked=${locked} reviewer=${reviewerActive} checks=${shape} pr=${prPresent} blocker=${blocker}`,
                        );
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  return count;
}


move8_describe('deriveCornerState invariants', () => {
  move8_it('enumerates archived, turns, checks, pull requests, and blockers', () => {
    const failures: string[] = [];
    const started = performance.now();
    const count = scan(failures, ['none', 'landed', 'done', 'abandoned', 'merged']);
    const elapsed = performance.now() - started;
    move8_expect(failures).toEqual([]);
    move8_expect(count).toBeGreaterThan(20_000);
    move8_expect(elapsed).toBeLessThan(1_000);
  });
});
});
