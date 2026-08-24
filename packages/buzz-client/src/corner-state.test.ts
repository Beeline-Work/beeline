import { describe, expect, it } from 'vitest';
import {
  CORNER_ACTIVITY_FRESHNESS_MS,
  KIND_CORNER_STATE,
  agentDraftKey,
  canTransitionCornerState,
  cornerStateKey,
  isCornerStateRecordCurrent,
  isCornerTerminalState,
  parseCornerStateRecord,
  type CornerMachineState,
} from './corner-state.js';
import { TAG_AGENT_DRAFT, TAG_CORNER_STATE } from './kinds.js';

function recordEvent(tags: string[][]) {
  return { tags } as unknown as Parameters<typeof parseCornerStateRecord>[0];
}

describe('corner lifecycle state machine', () => {
  const transitionMatrix: Readonly<
    Record<CornerMachineState | 'none', readonly CornerMachineState[]>
  > = {
    none: ['open', 'closed'],
    open: ['open', 'working', 'waiting', 'idle', 'concluded', 'closed'],
    working: ['working', 'waiting', 'idle', 'concluded', 'closed'],
    waiting: ['waiting', 'working', 'idle', 'concluded', 'closed'],
    idle: ['idle', 'working', 'waiting', 'concluded', 'closed'],
    concluded: ['concluded', 'closed'],
    closed: ['closed'],
  };
  const states: CornerMachineState[] = [
    'open',
    'working',
    'waiting',
    'idle',
    'concluded',
    'closed',
  ];

  it.each(
    (['none', ...states] as const).flatMap((from) =>
      states.map((to) => [from, to, transitionMatrix[from].includes(to)] as const),
    ),
  )('defines every transition edge %s -> %s as %s', (from, to, allowed) => {
    expect(canTransitionCornerState(from === 'none' ? undefined : from, to)).toBe(allowed);
  });

  it.each<[CornerMachineState | undefined, CornerMachineState]>([
    [undefined, 'open'],
    ['open', 'working'],
    ['working', 'waiting'],
    ['waiting', 'idle'],
    ['idle', 'concluded'],
    ['concluded', 'closed'],
  ])('allows the canonical edge %s -> %s', (from, to) => {
    expect(canTransitionCornerState(from, to)).toBe(true);
  });

  it.each<[CornerMachineState | undefined, CornerMachineState]>([
    [undefined, 'working'],
    ['working', 'open'],
    ['concluded', 'working'],
    ['closed', 'open'],
    ['closed', 'working'],
  ])('refuses an actor resurrection %s -> %s', (from, to) => {
    expect(canTransitionCornerState(from, to)).toBe(false);
  });

  it('permits cleanup to discover a corner directly as closed', () => {
    expect(canTransitionCornerState(undefined, 'closed')).toBe(true);
    expect(isCornerTerminalState('concluded')).toBe(true);
    expect(isCornerTerminalState('closed')).toBe(true);
    expect(isCornerTerminalState('idle')).toBe(false);
  });
});

describe('corner state record (wire contract)', () => {
  it('bounds state and draft replacements to one d-key per corner', () => {
    expect(cornerStateKey('abc')).toBe(`${TAG_CORNER_STATE}:abc`);
    expect(agentDraftKey('abc')).toBe(`${TAG_AGENT_DRAFT}:abc`);
    expect(cornerStateKey('a')).not.toBe(cornerStateKey('b'));
    expect(agentDraftKey('a')).not.toBe(agentDraftKey('b'));
  });

  it('parses the full state vocabulary and parent authority', () => {
    for (const state of ['open', 'working', 'waiting', 'idle', 'concluded', 'closed'] as const) {
      const record = parseCornerStateRecord(
        recordEvent([
          ['d', cornerStateKey('corner-1')],
          ['h', 'room-1'],
          ['state', state],
          ['at', '1700000123'],
        ]),
      );
      expect(record).toEqual({
        cornerId: 'corner-1',
        parentRoomId: 'room-1',
        state,
        at: 1_700_000_123,
      });
    }
  });

  it('normalizes the migration-only waiting-on-human word at the wire edge', () => {
    expect(
      parseCornerStateRecord(
        recordEvent([
          ['d', cornerStateKey('corner-1')],
          ['state', 'waiting-on-human'],
          ['reason', 'review'],
          ['at', '5'],
        ]),
      ),
    ).toMatchObject({ state: 'waiting', reason: 'review' });
  });

  it('degrades malformed shapes to absence', () => {
    const invalid = [
      [['d', 'unrelated']],
      [
        ['d', cornerStateKey('c')],
        ['state', 'gold'],
        ['at', '1'],
      ],
      [
        ['d', cornerStateKey('c')],
        ['state', 'idle'],
        ['reason', 'review'],
        ['at', '1'],
      ],
      [
        ['d', cornerStateKey('c')],
        ['state', 'waiting'],
        ['reason', 'done'],
        ['at', '1'],
      ],
      [
        ['d', cornerStateKey('c')],
        ['state', 'idle'],
        ['at', 'not-a-number'],
      ],
    ];
    for (const tags of invalid) expect(parseCornerStateRecord(recordEvent(tags))).toBeUndefined();
  });

  it('expires only the working lease at the 90-second horizon', () => {
    const at = 1_700_000_000;
    const working = { cornerId: 'c', state: 'working', at } as const;
    expect(isCornerStateRecordCurrent(working, at * 1_000 + CORNER_ACTIVITY_FRESHNESS_MS)).toBe(
      true,
    );
    expect(isCornerStateRecordCurrent(working, at * 1_000 + CORNER_ACTIVITY_FRESHNESS_MS + 1)).toBe(
      false,
    );
    expect(isCornerStateRecordCurrent({ ...working, state: 'idle' }, Number.MAX_SAFE_INTEGER)).toBe(
      true,
    );
    expect(isCornerStateRecordCurrent(undefined, at * 1_000)).toBe(false);
  });

  it('keeps the shared kind constant in one place', () => {
    expect(KIND_CORNER_STATE).toBe(30078);
  });
});
