import { describe, expect, it } from 'vitest';
import { foldSystemLines, joinSystemNames, systemLineText } from './system-lines';

const joined = (
  id: string,
  name: string,
  timestamp: number,
  kind: 'person' | 'agent' = 'person',
) => ({
  id,
  text: `${name} joined`,
  timestamp,
  isSystemNotice: true,
  systemEvent: { subject: { kind, id: `${id}-pubkey`, name }, verb: 'joined' },
});

describe('system lines on the phone', () => {
  it('renders the newcomer and inviter from the one structured join line', () => {
    expect(
      systemLineText({
        subject: { kind: 'agent', id: 'foxy', name: '@foxy' },
        verb: 'joined',
        consequence: 'invited by @moonscannerai',
      }),
    ).toBe('@foxy joined · invited by @moonscannerai');
  });

  it('joins names the way people say them', () => {
    expect(joinSystemNames([])).toBe('');
    expect(joinSystemNames(['@candy'])).toBe('@candy');
    expect(joinSystemNames(['@candy', '@terra'])).toBe('@candy and @terra');
    expect(joinSystemNames(['@candy', '@terra', '@codex'])).toBe('@candy, @terra and @codex');
  });

  it('folds consecutive lines with the same verb into one, oldest subject first', () => {
    const folded = foldSystemLines([
      joined('a', '@candy', 1),
      joined('b', '@terra', 2, 'agent'),
      joined('c', '@codex', 3, 'agent'),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      id: 'a',
      timestamp: 3,
      text: '@candy, @terra and @codex joined',
      foldedIds: ['a', 'b', 'c'],
    });
    expect(folded[0]!.systemSubjects!.map((subject) => subject.name)).toEqual([
      '@candy',
      '@terra',
      '@codex',
    ]);
  });

  it('never folds across a different verb, an ordinary message, or an old plain row', () => {
    const message = { id: 'm', text: 'hello', timestamp: 2, isUser: true };
    const left = {
      id: 'l',
      text: '@terra left',
      timestamp: 4,
      isSystemNotice: true,
      systemEvent: { subject: { kind: 'agent' as const, id: 't', name: '@terra' }, verb: 'left' },
    };
    const legacy = {
      id: 'old',
      text: 'Owner turned yolo on for Bee',
      timestamp: 5,
      isSystemNotice: true,
    };
    const folded = foldSystemLines([
      joined('a', '@candy', 1),
      message,
      joined('b', '@terra', 3),
      left,
      legacy,
      joined('c', '@codex', 6),
    ]);
    expect(folded.map((row) => row.id)).toEqual(['a', 'm', 'b', 'l', 'old', 'c']);
    expect(folded.every((row) => !row.foldedIds)).toBe(true);
  });

  it('keeps the object and consequence in a folded line and dedupes a repeated subject', () => {
    const yolo = (id: string, name: string, timestamp: number) => ({
      id,
      text: `${name} turned yolo on for @bee · grant requests are now approved automatically`,
      timestamp,
      isSystemNotice: true,
      systemEvent: {
        subject: { kind: 'person' as const, id: `${name}-id`, name },
        verb: 'turned yolo on for',
        object: { text: '@bee', id: 'bee' },
        consequence: 'grant requests are now approved automatically',
      },
    });
    const folded = foldSystemLines([
      yolo('a', '@owner', 1),
      yolo('b', '@admin', 2),
      yolo('c', '@owner', 3),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.text).toBe(
      '@owner and @admin turned yolo on for @bee · grant requests are now approved automatically',
    );
    expect(systemLineText(yolo('x', '@owner', 0).systemEvent)).toBe(
      '@owner turned yolo on for @bee · grant requests are now approved automatically',
    );
  });
});
