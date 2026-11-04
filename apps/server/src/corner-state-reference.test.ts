import { expect, it } from 'vitest';
import { deriveCornerState, type CornerStateFacts } from './corner-state.js';

/** Owner reference: docs/corner-state-reference.md. No production code or hashes as the oracle. */
it('CORNER-REFERENCE: exhausts independent activity, ending, CI and blocker facts', () => {
  let cases = 0;
  for (const archived of [false, true])
  for (const locked of [false, true])
  for (const ending of ['none', 'closed-run', 'landed-run', 'done', 'abandoned', 'merged'] as const)
  for (const turnRunning of [false, true])
  for (const reviewerActive of [false, true])
  for (const ci of ['none', 'pending', 'failing', 'passing', 'unreported', 'empty-fetched', 'pending-job'] as const)
  for (const blocked of [false, true]) {
    const summary = ci === 'unreported' || ci === 'empty-fetched' || ci === 'pending-job'
      ? { status: 'unknown' as const, total: ci === 'pending-job' ? 1 : 0,
          failing: [], checks: ci === 'pending-job' ? [{ name: 'check', status: 'pending' as const }] : [],
          updatedAt: 1, ...(ci === 'empty-fetched' ? { fetchStartedAt: 1 } : {}) } : undefined;
    const facts: CornerStateFacts = {
      archived, locked, turnRunning, reviewerActive,
      ...(ending === 'closed-run' || ending === 'landed-run' ? { run: { state: ending === 'closed-run' ? 'closed' : 'landed' } } : {}),
      lifecycle: { lifecycle: ending === 'done' ? 'done' : 'working',
        ...(ending === 'abandoned' ? { outcome: 'abandoned' } : {}),
        checks: ci === 'pending' ? 'pending' : ci === 'failing' ? 'failing' : ci === 'passing' ? 'passing' : 'unknown',
        ...(summary ? { checksSummary: summary } : {}),
        ...(ending === 'merged' || ci === 'unreported' || ci === 'empty-fetched' ? {
          pr: { number: 1, url: 'https://github.com/o/r/pull/1', title: 'Change', targetBranch: 'main', headSha: 'a'.repeat(40),
            ...(ending === 'merged' ? { mergedAt: '2026-11-01T00:00:00Z' } : {}) },
        } : {}),
      },
      ...(blocked ? { blocker: { reason: 'question' as const, itemId: 'reference' } } : {}),
    };
    const expected = archived || (!locked && ending !== 'none') ? 'archived'
      : turnRunning ? 'working'
      : reviewerActive || ['pending', 'unreported', 'pending-job'].includes(ci) ? 'review'
      : blocked ? 'waiting' : 'idle';
    expect(deriveCornerState(facts).state, JSON.stringify(facts)).toBe(expected);
    cases++;
  }
  expect(cases).toBe(1344);
});
