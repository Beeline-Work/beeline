import { describe, expect, it } from 'vitest';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import {
  cornerDisplayFacts,
  remoteTerminalState,
  resolveCornerDisplayState,
  unfinishedCornerDisplay,
  type CornerDisplayItem,
} from './corner-display-state';

const NOW = 1_800_000_000_000;
const FRESH = NOW / 1_000;

const pr = {
  number: 840,
  url: 'https://github.com/acme/beeline/pull/840',
  title: 'Fix pairing expiry',
  targetBranch: 'main',
  headSha: 'a'.repeat(40),
};

function lifecycle(overrides: Partial<CornerLifecycleView> = {}): CornerLifecycleView {
  return { lifecycle: 'working', checks: 'unknown', ...overrides };
}

describe('resolveCornerDisplayState — daemon authority', () => {
  it('reports a fresh working lease as working, whatever GitHub says', () => {
    const state = resolveCornerDisplayState(
      {
        machineState: 'working',
        stateAt: FRESH,
        lifecycle: lifecycle({ lifecycle: 'in-review', checks: 'failing', pr }),
      },
      NOW,
    );
    expect(state.status).toBe('live');
    expect(state.visual).toBe('working');
    expect(state.needsYou).toBe(false);
    expect(state.word).toBe('WORKING');
    expect(state.glyph).toBe('◌');
  });

  it('separates the three waiting reasons into three affordance words', () => {
    const review = resolveCornerDisplayState(
      { machineState: 'waiting', machineReason: 'review', lifecycle: lifecycle() },
      NOW,
    );
    const question = resolveCornerDisplayState(
      { machineState: 'waiting', machineReason: 'question', lifecycle: lifecycle() },
      NOW,
    );
    const failure = resolveCornerDisplayState(
      { machineState: 'waiting', machineReason: 'failure', lifecycle: lifecycle() },
      NOW,
    );
    expect([review.status, review.word]).toEqual(['open', 'REVIEW']);
    expect([question.status, question.word]).toEqual(['needs-attention', 'REPLY']);
    expect([failure.status, failure.word]).toEqual(['failed', 'RETRY']);
    for (const state of [review, question, failure]) {
      expect(state.needsYou).toBe(true);
      // Brass is never the only signal: the filled circle and the word carry
      // the same fact in shape and copy.
      expect(state.glyph).toBe('●');
    }
  });

  it('keeps a stale working lease with the daemon rather than handing it to GitHub', () => {
    // The lease expiring demotes the corner to idle. It does not make a merged
    // PR the authority on a corner the daemon last said was being worked on.
    const state = resolveCornerDisplayState(
      {
        machineState: 'working',
        stateAt: FRESH - 600,
        lifecycle: lifecycle({
          lifecycle: 'done',
          pr: { ...pr, mergedAt: '2026-09-10T00:00:00Z' },
        }),
      },
      NOW,
    );
    expect(state.status).toBeNull();
    expect(state.word).toBe('IDLE');
    expect(state.terminal).toBe(false);
  });

  it('reports the daemon conclusion as terminal', () => {
    expect(resolveCornerDisplayState({ machineState: 'concluded' }, NOW)).toMatchObject({
      status: 'merged',
      word: 'MERGED',
      terminal: true,
      needsYou: false,
    });
    expect(resolveCornerDisplayState({ machineState: 'closed' }, NOW)).toMatchObject({
      status: 'archived',
      word: 'CLOSED',
      terminal: true,
    });
  });
});

describe('resolveCornerDisplayState — remote facts where the daemon is silent', () => {
  it('lands a corner whose PR merged', () => {
    const state = resolveCornerDisplayState(
      {
        machineState: 'idle',
        lifecycle: lifecycle({
          lifecycle: 'done',
          pr: { ...pr, mergedAt: '2026-09-10T00:00:00Z' },
        }),
      },
      NOW,
    );
    expect(state.status).toBe('merged');
    expect(state.terminal).toBe(true);
  });

  it('calls a failing check a retry, not a review', () => {
    const state = resolveCornerDisplayState(
      {
        machineState: 'idle',
        lifecycle: lifecycle({ lifecycle: 'in-review', checks: 'failing', pr }),
      },
      NOW,
    );
    expect(state.status).toBe('failed');
    expect(state.needsYou).toBe(true);
    expect(state.word).toBe('RETRY');
  });

  it('prefers the webhook check summary over the coarse check word', () => {
    const state = resolveCornerDisplayState(
      {
        machineState: 'idle',
        lifecycle: lifecycle({
          lifecycle: 'in-review',
          checks: 'passing',
          pr,
          checksSummary: {
            status: 'failing',
            total: 2,
            failing: ['lint'],
            checks: [
              { name: 'lint', status: 'failed' },
              { name: 'build', status: 'passed' },
            ],
            updatedAt: FRESH,
          },
        }),
      },
      NOW,
    );
    expect(state.status).toBe('failed');
  });

  it('calls a conflicted PR a retry even when every check passed', () => {
    const state = resolveCornerDisplayState(
      {
        machineState: 'idle',
        lifecycle: lifecycle({
          lifecycle: 'in-review',
          checks: 'passing',
          pr: { ...pr, mergeability: 'dirty' },
        }),
      },
      NOW,
    );
    expect(state.status).toBe('failed');
    expect(state.detail).toBe('PR #840 · merge conflict');
  });

  it('asks for review on a clean open PR', () => {
    const state = resolveCornerDisplayState(
      {
        machineState: 'idle',
        lifecycle: lifecycle({ lifecycle: 'in-review', checks: 'passing', pr }),
      },
      NOW,
    );
    expect(state.status).toBe('open');
    expect(state.word).toBe('REVIEW');
    expect(state.prUrl).toBe(pr.url);
  });

  it('stays idle with no PR and nothing to say', () => {
    const state = resolveCornerDisplayState({ machineState: 'idle', lifecycle: lifecycle() }, NOW);
    expect(state.status).toBeNull();
    expect(state.word).toBe('IDLE');
    expect(state.glyph).toBe('○');
    expect(state.detail).toBeUndefined();
  });

  it('lets an awaiting reply speak where no canonical status exists', () => {
    const state = resolveCornerDisplayState({ machineState: 'idle', awaitingReply: true }, NOW);
    expect(state.status).toBeNull();
    expect(state.needsYou).toBe(true);
    expect(state.word).toBe('REPLY');
  });
});

describe('resolveCornerDisplayState — the detail line', () => {
  it('narrates PR and checks without letting them become the status', () => {
    const state = resolveCornerDisplayState(
      {
        machineState: 'working',
        stateAt: FRESH,
        lifecycle: lifecycle({
          lifecycle: 'in-review',
          checks: 'pending',
          pr,
          checksSummary: {
            status: 'pending',
            total: 3,
            failing: [],
            checks: [
              { name: 'lint', status: 'passed' },
              { name: 'build', status: 'pending' },
              { name: 'deploy', status: 'pending' },
            ],
            updatedAt: FRESH,
          },
        }),
      },
      NOW,
    );
    expect(state.status).toBe('live');
    expect(state.detail).toBe('PR #840 · 1/3 tests passed · running');
  });

  it('says nothing before a pull request exists', () => {
    expect(
      resolveCornerDisplayState(
        { machineState: 'working', stateAt: FRESH, lifecycle: lifecycle() },
        NOW,
      ).detail,
    ).toBeUndefined();
  });
});

describe('unfinishedCornerDisplay', () => {
  function item(overrides: Partial<CornerDisplayItem>): CornerDisplayItem {
    return { status: 'idle', lifecycle: lifecycle(), ...overrides };
  }

  it('drops corners the daemon concluded even when their lifecycle still reads working', () => {
    // The old dropdown filtered on `lifecycle.lifecycle !== 'done'` alone, so a
    // corner the daemon had concluded stayed listed while the Room row's count
    // — derived from the daemon — had already dropped it.
    const kept = unfinishedCornerDisplay(
      [
        item({ status: 'concluded' }),
        item({ status: 'closed' }),
        item({ status: 'waiting', reason: 'review' }),
        item({ status: 'working', statusAt: FRESH }),
        item({ status: 'idle' }),
      ],
      NOW,
    );
    expect(kept.map((entry) => entry.item.status)).toEqual(['waiting', 'working', 'idle']);
  });

  it('drops a merged PR the daemon never reported on', () => {
    const kept = unfinishedCornerDisplay(
      [
        item({
          status: 'idle',
          lifecycle: lifecycle({
            lifecycle: 'done',
            pr: { ...pr, mergedAt: '2026-09-10T00:00:00Z' },
          }),
        }),
      ],
      NOW,
    );
    expect(kept).toEqual([]);
  });

  it('keeps failures listed, because a failure is the most actionable row there is', () => {
    const kept = unfinishedCornerDisplay([item({ status: 'waiting', reason: 'failure' })], NOW);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.display.needsYou).toBe(true);
  });
});

describe('remoteTerminalState', () => {
  it('calls a merged PR finished before the branch is reaped', () => {
    // The daemon only writes `done` once the branch is gone. Between the merge
    // and the reap the lifecycle word still reads `in-review`.
    expect(
      remoteTerminalState(
        lifecycle({ lifecycle: 'in-review', pr: { ...pr, mergedAt: '2026-09-10T00:00:00Z' } }),
      ),
    ).toBe('concluded');
  });

  it('separates a landing from an abandonment', () => {
    expect(remoteTerminalState(lifecycle({ lifecycle: 'done', outcome: 'landed' }))).toBe(
      'concluded',
    );
    expect(remoteTerminalState(lifecycle({ lifecycle: 'done', outcome: 'abandoned' }))).toBe(
      'closed',
    );
    // A `done` lifecycle with no outcome is a corner that ended without
    // landing: closed, never merged.
    expect(remoteTerminalState(lifecycle({ lifecycle: 'done' }))).toBe('closed');
  });

  it('says nothing about a corner still in flight', () => {
    expect(remoteTerminalState(lifecycle())).toBeUndefined();
    expect(
      remoteTerminalState(lifecycle({ lifecycle: 'in-review', checks: 'failing', pr })),
    ).toBeUndefined();
    expect(remoteTerminalState(undefined)).toBeUndefined();
  });
});

describe('cornerDisplayFacts', () => {
  it('carries the daemon triple across without inventing absent fields', () => {
    expect(cornerDisplayFacts({ status: 'idle', lifecycle: lifecycle() })).toEqual({
      machineState: 'idle',
      lifecycle: lifecycle(),
    });
    expect(
      cornerDisplayFacts({
        status: 'waiting',
        reason: 'question',
        statusAt: FRESH,
        lifecycle: lifecycle(),
      }),
    ).toEqual({
      machineState: 'waiting',
      machineReason: 'question',
      stateAt: FRESH,
      lifecycle: lifecycle(),
    });
  });
});
