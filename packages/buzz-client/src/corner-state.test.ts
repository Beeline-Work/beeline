import { describe, expect, it } from 'vitest';
import {
  KIND_CORNER_STATE,
  cornerStateKey,
  isCornerStateRecordCurrent,
  parseCornerStateRecord,
} from './corner-state.js';
import { TAG_CORNER_STATE } from './kinds.js';

function recordEvent(tags: string[][]) {
  return { tags } as unknown as Parameters<typeof parseCornerStateRecord>[0];
}

describe('corner state record (wire contract)', () => {
  it('keys records by `d`, never `h` — kind:30078 replaceables are d-indexed', () => {
    expect(cornerStateKey('abc')).toBe(`${TAG_CORNER_STATE}:abc`);
    // Distinct corners never collide, and the key round-trips the corner id.
    expect(cornerStateKey('a')).not.toBe(cornerStateKey('b'));
    expect(cornerStateKey('abc').slice(TAG_CORNER_STATE.length + 1)).toBe('abc');
  });

  it('parses a well-formed record with state, reason, and at', () => {
    const record = parseCornerStateRecord(
      recordEvent([
        ['d', cornerStateKey('corner-1')],
        ['h', 'room-1'],
        ['t', 'buzz-corner-state'],
        ['state', 'waiting-on-human'],
        ['reason', 'review'],
        ['at', '1700000123'],
      ]),
    );
    expect(record).toEqual({
      cornerId: 'corner-1',
      state: 'waiting-on-human',
      reason: 'review',
      at: 1_700_000_123,
    });
  });

  it('parses a reason-less record', () => {
    const record = parseCornerStateRecord(
      recordEvent([
        ['d', cornerStateKey('c2')],
        ['state', 'working'],
        ['at', '5'],
      ]),
    );
    expect(record).toMatchObject({ cornerId: 'c2', state: 'working' });
    expect(record?.reason).toBeUndefined();
  });

  it('degrades to undefined on malformed shapes — absence means fall back, never throw', () => {
    expect(parseCornerStateRecord(recordEvent([['d', 'unrelated']]))).toBeUndefined();
    expect(
      parseCornerStateRecord(
        recordEvent([
          ['d', cornerStateKey('c')],
          ['state', 'gold'],
        ]),
      ),
    ).toBeUndefined();
    expect(
      parseCornerStateRecord(
        recordEvent([
          ['d', cornerStateKey('c')],
          ['state', 'idle'],
          ['at', 'not-a-number'],
        ]),
      ),
    ).toBeUndefined();
    expect(
      parseCornerStateRecord(
        recordEvent([
          ['d', cornerStateKey('c')],
          ['state', 'idle'],
        ]),
      ),
    ).toBeUndefined();
    expect(
      parseCornerStateRecord(
        recordEvent([
          ['d', cornerStateKey('c')],
          ['state', 'waiting-on-human'],
          ['reason', 'done'],
          ['at', '1'],
        ]),
      ),
    ).toBeUndefined();
    expect(
      parseCornerStateRecord(
        recordEvent([
          ['d', cornerStateKey('')],
          ['state', 'idle'],
          ['at', '-1'],
        ]),
      ),
    ).toBeUndefined();
  });

  it('accepts every machine state word and rejects non-machine ones', () => {
    for (const state of ['working', 'waiting-on-human', 'idle']) {
      expect(
        parseCornerStateRecord(
          recordEvent([
            ['d', cornerStateKey('c')],
            ['state', state],
            ['at', '1'],
          ]),
        )?.state,
      ).toBe(state);
    }
    for (const reason of ['review', 'question', 'failure']) {
      expect(
        parseCornerStateRecord(
          recordEvent([
            ['d', cornerStateKey('c')],
            ['state', 'waiting-on-human'],
            ['reason', reason],
            ['at', '1'],
          ]),
        )?.reason,
      ).toBe(reason);
    }
    expect(
      parseCornerStateRecord(
        recordEvent([
          ['d', cornerStateKey('c')],
          ['state', 'finished'],
          ['at', '1'],
        ]),
      ),
    ).toBeUndefined();
  });

  it('freshness: a record at or after the newest transcript event is current', () => {
    const record = parseCornerStateRecord(
      recordEvent([
        ['d', cornerStateKey('c')],
        ['state', 'working'],
        ['at', '100'],
      ]),
    );
    expect(isCornerStateRecordCurrent(record, 100)).toBe(true);
    expect(isCornerStateRecordCurrent(record, 99)).toBe(true);
    expect(isCornerStateRecordCurrent(record, 101)).toBe(false);
    expect(isCornerStateRecordCurrent(undefined, 0)).toBe(false);
  });

  it('the shared kind constant stays in one place', () => {
    expect(KIND_CORNER_STATE).toBe(30078);
  });
});
