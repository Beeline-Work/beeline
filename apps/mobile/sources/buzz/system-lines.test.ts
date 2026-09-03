import { describe, expect, it } from 'vitest';
import { foldSystemLines, joinSystemNames, systemLineText } from './system-lines';

const joined = (id: string, name: string, timestamp: number, kind: 'person' | 'agent' = 'person') => ({
  id,
  text: `${name} joined`,
  timestamp,
  isSystemNotice: true,
  systemEvent: { subject: { kind, id: `${id}-pubkey`, name }, verb: 'joined' },
});

describe('system lines on the phone', () => {
  it('joins names the way people say them', () => {
    expect(joinSystemNames([])).toBe('');
    expect(joinSystemNames(['Candy'])).toBe('Candy');
    expect(joinSystemNames(['Candy', 'Terra'])).toBe('Candy and Terra');
    expect(joinSystemNames(['Candy', 'Terra', 'Codex'])).toBe('Candy, Terra and Codex');
  });

  it('folds consecutive lines with the same verb into one, oldest subject first', () => {
    const folded = foldSystemLines([
      joined('a', 'Candy', 1),
      joined('b', 'Terra', 2, 'agent'),
      joined('c', 'Codex', 3, 'agent'),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      id: 'a',
      timestamp: 3,
      text: 'Candy, Terra and Codex joined',
      foldedIds: ['a', 'b', 'c'],
    });
    expect(folded[0]!.systemSubjects!.map((subject) => subject.name)).toEqual([
      'Candy',
      'Terra',
      'Codex',
    ]);
  });

  it('never folds across a different verb, an ordinary message, or an old plain row', () => {
    const message = { id: 'm', text: 'hello', timestamp: 2, isUser: true };
    const left = {
      id: 'l',
      text: 'Terra left',
      timestamp: 4,
      isSystemNotice: true,
      systemEvent: { subject: { kind: 'agent' as const, id: 't', name: 'Terra' }, verb: 'left' },
    };
    const legacy = { id: 'old', text: 'Owner turned yolo on for Bee', timestamp: 5, isSystemNotice: true };
    const folded = foldSystemLines([joined('a', 'Candy', 1), message, joined('b', 'Terra', 3), left, legacy, joined('c', 'Codex', 6)]);
    expect(folded.map((row) => row.id)).toEqual(['a', 'm', 'b', 'l', 'old', 'c']);
    expect(folded.every((row) => !row.foldedIds)).toBe(true);
  });

  it('keeps the object and consequence in a folded line and dedupes a repeated subject', () => {
    const yolo = (id: string, name: string, timestamp: number) => ({
      id,
      text: `${name} turned yolo on for Bee · grant requests are now approved automatically`,
      timestamp,
      isSystemNotice: true,
      systemEvent: {
        subject: { kind: 'person' as const, id: `${name}-id`, name },
        verb: 'turned yolo on for',
        object: { text: 'Bee', id: 'bee' },
        consequence: 'grant requests are now approved automatically',
      },
    });
    const folded = foldSystemLines([yolo('a', 'Owner', 1), yolo('b', 'Admin', 2), yolo('c', 'Owner', 3)]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.text).toBe(
      'Owner and Admin turned yolo on for Bee · grant requests are now approved automatically',
    );
    expect(systemLineText(yolo('x', 'Owner', 0).systemEvent)).toBe(
      'Owner turned yolo on for Bee · grant requests are now approved automatically',
    );
  });
});
