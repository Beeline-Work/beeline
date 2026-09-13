import { describe, expect, it } from 'vitest';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import {
  cornerDisplayFacts,
  cornerHeaderStateLabel,
  remoteTerminalState,
  resolveCornerDisplayState,
  unfinishedCornerDisplay,
  type CornerDisplayFacts,
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

describe('resolveCornerDisplayState — four-state matrix', () => {
  const matrix: ReadonlyArray<{
    legacy: string;
    facts: CornerDisplayFacts;
    expected: 'working' | 'waiting' | 'review' | 'archived';
  }> = [
    { legacy: 'open', facts: { machineState: 'open' }, expected: 'waiting' },
    { legacy: 'working', facts: { machineState: 'working', stateAt: FRESH }, expected: 'working' },
    {
      legacy: 'stale working',
      facts: { machineState: 'working', stateAt: 1 },
      expected: 'waiting',
    },
    {
      legacy: 'waiting/question',
      facts: { machineState: 'waiting', machineReason: 'question' },
      expected: 'waiting',
    },
    {
      legacy: 'waiting/failure',
      facts: { machineState: 'waiting', machineReason: 'failure' },
      expected: 'waiting',
    },
    {
      legacy: 'waiting/review',
      facts: { machineState: 'waiting', machineReason: 'review' },
      expected: 'review',
    },
    { legacy: 'idle', facts: { machineState: 'idle' }, expected: 'waiting' },
    { legacy: 'absent', facts: {}, expected: 'waiting' },
    { legacy: 'concluded', facts: { machineState: 'concluded' }, expected: 'archived' },
    { legacy: 'closed', facts: { machineState: 'closed' }, expected: 'archived' },
    { legacy: 'viewer archived', facts: { archived: true }, expected: 'archived' },
    {
      legacy: 'PR checks pending',
      facts: {
        machineState: 'idle',
        lifecycle: lifecycle({ lifecycle: 'in-review', checks: 'pending', pr }),
      },
      expected: 'review',
    },
    {
      legacy: 'PR checks passed',
      facts: {
        machineState: 'idle',
        lifecycle: lifecycle({ lifecycle: 'in-review', checks: 'passing', pr }),
      },
      expected: 'review',
    },
    {
      legacy: 'PR checks failed',
      facts: {
        machineState: 'idle',
        lifecycle: lifecycle({ lifecycle: 'in-review', checks: 'failing', pr }),
      },
      expected: 'review',
    },
    {
      legacy: 'merged PR',
      facts: {
        machineState: 'idle',
        lifecycle: lifecycle({ pr: { ...pr, mergedAt: '2026-09-10T00:00:00Z' } }),
      },
      expected: 'archived',
    },
    {
      legacy: 'abandoned',
      facts: {
        machineState: 'idle',
        lifecycle: lifecycle({ lifecycle: 'done', outcome: 'abandoned' }),
      },
      expected: 'archived',
    },
  ];

  for (const entry of matrix) {
    it(`${entry.legacy} → ${entry.expected}`, () => {
      expect(resolveCornerDisplayState(entry.facts, NOW).status).toBe(entry.expected);
    });
  }

  it('keeps a running turn working even after its PR exists', () => {
    expect(
      resolveCornerDisplayState(
        {
          machineState: 'working',
          stateAt: FRESH,
          lifecycle: lifecycle({ checks: 'failing', pr }),
        },
        NOW,
      ).status,
    ).toBe('working');
  });

  it('uses exactly one existing color-token tier per state', () => {
    expect([
      resolveCornerDisplayState({ machineState: 'working', stateAt: FRESH }, NOW).tone,
      resolveCornerDisplayState({}, NOW).tone,
      resolveCornerDisplayState({ machineState: 'waiting', machineReason: 'review' }, NOW).tone,
      resolveCornerDisplayState({ machineState: 'closed' }, NOW).tone,
    ]).toEqual(['work', 'quiet', 'brass', 'ghost']);
  });
});

describe('four-state surface snapshots', () => {
  const states: Record<string, CornerDisplayFacts> = {
    working: { machineState: 'working', stateAt: FRESH },
    waiting: { machineState: 'waiting', machineReason: 'failure' },
    review: { machineState: 'idle', lifecycle: lifecycle({ checks: 'failing', pr }) },
    archived: { machineState: 'closed' },
  };

  it('snapshots the Room-list row label for every state', () => {
    expect(
      Object.fromEntries(
        Object.entries(states).map(([key, facts]) => {
          const display = resolveCornerDisplayState(facts, NOW);
          return [key, { label: display.word, tone: display.tone }];
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "archived": {
          "label": "archived",
          "tone": "ghost",
        },
        "review": {
          "label": "review",
          "tone": "brass",
        },
        "waiting": {
          "label": "waiting",
          "tone": "quiet",
        },
        "working": {
          "label": "working",
          "tone": "work",
        },
      }
    `);
  });

  it('snapshots the corner header label for every state and keeps failure reasons quiet', () => {
    expect(
      Object.fromEntries(
        Object.entries(states).map(([key, facts]) => [
          key,
          cornerHeaderStateLabel(resolveCornerDisplayState(facts, NOW)),
        ]),
      ),
    ).toMatchInlineSnapshot(`
      {
        "archived": "archived",
        "review": "review · checks failed",
        "waiting": "waiting · failed",
        "working": "working",
      }
    `);
  });
});

describe('unfinishedCornerDisplay', () => {
  function item(overrides: Partial<CornerDisplayItem>): CornerDisplayItem {
    return { status: 'idle', lifecycle: lifecycle(), ...overrides };
  }

  it('keeps only the three unfinished display states', () => {
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
    expect(kept.map((entry) => entry.display.status)).toEqual(['review', 'working', 'waiting']);
  });

  it('drops remote terminal corners before daemon cleanup', () => {
    expect(
      unfinishedCornerDisplay(
        [item({ status: 'idle', lifecycle: lifecycle({ lifecycle: 'done', outcome: 'landed' }) })],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe('remoteTerminalState', () => {
  it('retains the server-machine adapter vocabulary', () => {
    expect(remoteTerminalState(lifecycle({ outcome: 'landed' }))).toBe('concluded');
    expect(remoteTerminalState(lifecycle({ lifecycle: 'done', outcome: 'abandoned' }))).toBe(
      'closed',
    );
    expect(remoteTerminalState(lifecycle())).toBeUndefined();
  });
});

describe('cornerDisplayFacts', () => {
  it('carries the daemon fields without changing persistence vocabulary', () => {
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
