import { describe, expect, it } from 'vitest';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { cornerStatusLine } from './corner-status-line';

const pr = {
  number: 840,
  url: 'https://github.com/acme/beeline/pull/840',
  title: 'Fix pairing expiry',
  targetBranch: 'main',
  headSha: 'a'.repeat(40),
};

function check(
  name: string,
  status: 'pending' | 'passed' | 'failed',
  conclusion?: string,
): { name: string; status: 'pending' | 'passed' | 'failed'; conclusion?: string } {
  return { name, status, ...(conclusion ? { conclusion } : {}) };
}

function view(overrides: Partial<CornerLifecycleView>): CornerLifecycleView {
  return { lifecycle: 'in-review', checks: 'unknown', pr, ...overrides };
}

describe('cornerStatusLine', () => {
  it('renders nothing before a pull request exists', () => {
    expect(cornerStatusLine(undefined, false)).toBeUndefined();
    expect(cornerStatusLine({ lifecycle: 'working', checks: 'unknown' }, false)).toBeUndefined();
    expect(cornerStatusLine({ lifecycle: 'done', checks: 'unknown' }, true)).toBeUndefined();
  });

  it('counts passed checks, including skipped ones, while checks run', () => {
    const checks = [
      check('MOBILE SUITE', 'passed', 'success'),
      check('BODY SUITE', 'passed', 'success'),
      check('container build', 'passed', 'skipped'),
      check('lint', 'pending'),
      check('deploy', 'pending'),
    ];
    const lifecycle = view({
      checks: 'pending',
      checksSummary: { status: 'pending', total: 15, failing: [], checks, updatedAt: 1 },
    });
    expect(cornerStatusLine(lifecycle, false)).toBe('PR #840 · 3/15 tests passed · running');
  });

  it('falls back to the reported check count when no total is given', () => {
    const lifecycle = view({
      checks: 'pending',
      checksSummary: {
        status: 'pending',
        total: 0,
        failing: [],
        checks: [check('a', 'passed'), check('b', 'pending')],
        updatedAt: 1,
      },
    });
    expect(cornerStatusLine(lifecycle, false)).toBe('PR #840 · 1/2 tests passed · running');
    expect(cornerStatusLine(view({ checks: 'pending' }), false)).toBe('PR #840 · tests running');
  });

  it('says all tests passed once every check is green', () => {
    const lifecycle = view({
      checks: 'passing',
      checksSummary: {
        status: 'passing',
        total: 15,
        failing: [],
        checks: [check('MOBILE SUITE', 'passed', 'success')],
        updatedAt: 1,
      },
    });
    expect(cornerStatusLine(lifecycle, false)).toBe('PR #840 · all 15 tests passed');
  });

  it('counts failures and names the first failing check, title-cased, behind the × glyph', () => {
    const lifecycle = view({
      checks: 'failing',
      checksSummary: {
        status: 'failing',
        total: 15,
        failing: ['MOBILE SUITE', 'BODY SUITE'],
        checks: [
          check('typecheck', 'passed', 'success'),
          check('MOBILE SUITE', 'failed', 'failure'),
          check('BODY SUITE', 'failed', 'failure'),
        ],
        updatedAt: 1,
      },
    });
    expect(cornerStatusLine(lifecycle, false)).toBe('PR #840 · 2 tests failed × Mobile suite');
  });

  it('uses the singular for one failure and names it from the failing list when needed', () => {
    const lifecycle = view({
      checks: 'failing',
      checksSummary: { status: 'failing', total: 3, failing: ['lint'], checks: [], updatedAt: 1 },
    });
    expect(cornerStatusLine(lifecycle, false)).toBe('PR #840 · 1 test failed × Lint');
  });

  it('lets a merge conflict outrank the check copy', () => {
    const lifecycle = view({
      checks: 'passing',
      pr: { ...pr, mergeability: 'dirty' },
      checksSummary: {
        status: 'passing',
        total: 2,
        failing: [],
        checks: [check('a', 'passed'), check('b', 'passed')],
        updatedAt: 1,
      },
    });
    expect(cornerStatusLine(lifecycle, false)).toBe('PR #840 · merge conflict');
  });

  it('reports no tests configured when GitHub never reported a check', () => {
    expect(cornerStatusLine(view({ checks: 'unknown' }), false)).toBe(
      'PR #840 · no tests configured',
    );
    expect(
      cornerStatusLine(
        view({
          checks: 'unknown',
          checksSummary: { status: 'unknown', total: 0, failing: [], checks: [], updatedAt: 1 },
        }),
        false,
      ),
    ).toBe('PR #840 · no tests configured');
  });

  it('says merged once the PR landed, whether by merge fact or outcome', () => {
    expect(
      cornerStatusLine(view({ pr: { ...pr, mergedAt: '2026-09-03T10:00:00Z' } }), true),
    ).toBe('PR #840 · merged');
    expect(cornerStatusLine(view({ lifecycle: 'done', outcome: 'landed' }), true)).toBe(
      'PR #840 · merged',
    );
    expect(
      cornerStatusLine(view({ checks: 'failing', pr: { ...pr, mergedAt: '2026-09-03T10:00:00Z' } }), false),
    ).toBe('PR #840 · merged');
  });

  it('says closed for an archived corner whose PR never merged', () => {
    expect(
      cornerStatusLine(view({ lifecycle: 'done', checks: 'failing', outcome: 'abandoned' }), true),
    ).toBe('PR #840 · closed');
  });
});
