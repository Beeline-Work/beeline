import { describe, expect, it } from 'vitest';
import { deriveCornerState, type CornerStateFacts } from './corner-state.js';
import type { CornerLifecycleView, CornerState } from './phone-types.js';

/**
 * Invariants for `deriveCornerState`, including precedence when they overlap.
 *
 * 1. `archived` iff the corner, its run, or its lifecycle is landed or closed.
 * 2. `review` iff a reviewer turn is active and checks are not failing, or
 *    checks are pending on the current head with no human-owed blocker and
 *    no worker turn running.
 * 3. `working` is a running worker turn, the 30-minute repair window after
 *    checks start failing with no blocker, or the 30-second grace after a
 *    non-failing turn. It does not override archived. A live reviewer beats
 *    it only while checks are not failing.
 * 4. `waiting` iff there is a blocker and it is not the case that checks are
 *    pending on the current head and every blocker is owed to an agent.
 *    This scan leaves `stallReport` unset, so an agent-commander report on a
 *    red head stays waiting.
 * 5. Anything else left over is `idle`, including failing checks once the
 *    repair window is missing or older than 30 minutes.
 *
 * `workerQueued` is enumerated and must not change the result. `ciStartedAt`
 * does not end a pending run. It does open the failing-check repair window.
 */

const NOW = 1_700_000_000;
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
type Grace = 'within' | 'outside' | 'absent';
type CiAge = 'fresh' | 'stale' | 'absent';

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
const GRACES: readonly Grace[] = ['within', 'outside', 'absent'];
const AGES: readonly CiAge[] = ['fresh', 'stale', 'absent'];

function lifecycleFor(shape: CheckShape, prPresent: boolean, closure: Closure): CornerLifecycleView {
  const checks =
    shape === 'pending' ? 'pending' : shape === 'passing' ? 'passing' : shape === 'failing' ? 'failing' : 'unknown';
  let lifecycle: CornerLifecycleView = {
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

function blockerFacts(kind: BlockerKind): Pick<CornerStateFacts, 'owed' | 'agentCommanderReport' | 'blocker'> {
  if (kind === 'none') return { owed: false };
  if (kind === 'agent') {
    return {
      owed: true,
      agentCommanderReport: true,
      blocker: { reason: 'question', blocker: { kind: 'report', personId: 'commander' } },
    };
  }
  if (kind === 'merge-hold') {
    return {
      owed: true,
      blocker: { reason: 'approve', blocker: { kind: 'merge-hold', personId: 'human' } },
    };
  }
  // A human item beside an agent report is not agent-only. `cornerRowState`
  // leaves `agentCommanderReport` unset when any blocker is owed to a human.
  const reason = kind === 'human-approve' ? 'approve' : kind === 'human-connect' ? 'connect' : 'question';
  return {
    owed: true,
    blocker: { reason, blocker: { kind: 'message', personId: 'human' } },
  };
}

function pendingOnHead(facts: CornerStateFacts): boolean {
  const lifecycle = facts.lifecycle;
  const checks = lifecycle?.checksSummary?.status ?? lifecycle?.checks;
  const summary = lifecycle?.checksSummary;
  const unreported =
    Boolean(lifecycle?.pr) &&
    summary?.status === 'unknown' &&
    summary.total === 0 &&
    summary.fetchStartedAt === undefined;
  return checks !== 'failing' && (checks === 'pending' || unreported);
}

function isClosed(facts: CornerStateFacts): boolean {
  if (facts.archived) return true;
  if (facts.run?.state === 'landed' || facts.run?.state === 'closed') return true;
  const lifecycle = facts.lifecycle;
  const raw = String(lifecycle?.lifecycle ?? '').trim().toLowerCase();
  if (lifecycle?.pr?.mergedAt || lifecycle?.outcome === 'landed' || raw === 'merged') return true;
  if (lifecycle?.outcome === 'abandoned') return true;
  if (['done', 'concluded', 'closed', 'abandoned', 'cleaned'].includes(raw)) return true;
  return false;
}

function scan(
  failures: string[],
  closures: readonly Closure[],
  ages: readonly CiAge[],
  queuedValues: readonly boolean[],
): number {
  let count = 0;
  for (const archived of [false, true]) {
    for (const run of RUNS) {
      for (const closure of closures) {
        for (const turnRunning of [false, true]) {
          for (const grace of GRACES) {
            for (const workerQueued of queuedValues) {
              for (const reviewerActive of [false, true]) {
                for (const shape of CHECKS) {
                  for (const prPresent of [false, true]) {
                    if (closure === 'merged' && !prPresent) continue;
                    for (const blocker of BLOCKERS) {
                      for (const age of ages) {
                        count += 1;
                        const facts: CornerStateFacts = {
                          archived,
                          turnRunning,
                          workerQueued,
                          reviewerActive,
                          now: NOW,
                          ...(run ? { run } : {}),
                          ...(grace === 'within' ? { lastTurnEndedAt: NOW - 10 } : {}),
                          ...(grace === 'outside' ? { lastTurnEndedAt: NOW - 40 } : {}),
                          ...(age === 'fresh' ? { ciStartedAt: NOW - 10 } : {}),
                          ...(age === 'stale' ? { ciStartedAt: NOW - 31 * 60 } : {}),
                          lifecycle: lifecycleFor(shape, prPresent, closure),
                          ...blockerFacts(blocker),
                        };
                        const actual: CornerState = deriveCornerState(facts).state;
                        const closed = isClosed(facts);
                        const pending = pendingOnHead(facts);
                        const anyBlocker = blocker !== 'none';
                        const agentOnly = blocker === 'agent';
                        const checks = facts.lifecycle?.checksSummary?.status ?? facts.lifecycle?.checks;
                        const failing = checks === 'failing';
                        const repairOpen =
                          facts.ciStartedAt !== undefined && NOW - facts.ciStartedAt < 30 * 60;
                        let expected: CornerState;
                        if (closed) expected = 'archived';
                        else if (reviewerActive && !failing) expected = 'review';
                        else if (turnRunning) expected = 'working';
                        else if (failing && !anyBlocker) expected = repairOpen ? 'working' : 'idle';
                        else if (anyBlocker && !(pending && agentOnly)) expected = 'waiting';
                        else if (pending) expected = 'review';
                        else if (
                          facts.lastTurnEndedAt !== undefined &&
                          NOW - facts.lastTurnEndedAt < 30
                        )
                          expected = 'working';
                        else expected = 'idle';
                        if (actual !== expected && failures.length < 8) {
                          failures.push(
                            `got ${actual} expected ${expected} archived=${archived} run=${run?.state ?? '-'} closure=${closure} turn=${turnRunning} grace=${grace} queued=${workerQueued} reviewer=${reviewerActive} checks=${shape} pr=${prPresent} blocker=${blocker} age=${age}`,
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
    }
  }
  return count;
}

describe('deriveCornerState invariants', () => {
  it('enumerates archived, turns, grace, checks, pull requests, and blockers', () => {
    const failures: string[] = [];
    const started = performance.now();
    // Clock age is independent of landed/closed, so the full age cross runs once
    // and each closure is checked against one age.
    const count =
      scan(failures, ['none'], AGES, [false, true]) +
      scan(failures, ['landed', 'done', 'abandoned', 'merged'], ['stale'], [false]);
    const elapsed = performance.now() - started;
    expect(failures).toEqual([]);
    expect(count).toBeGreaterThan(50_000);
    expect(elapsed).toBeLessThan(1_000);
  });
});
