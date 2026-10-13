import { describe, expect, it } from 'vitest';
import { joinSystemNames, systemLineText } from './system-lines';

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

  it('keeps consecutive same-verb notices with their original text, stamps and anchors', () => {
    const messages = [
      joined('a', '@candy', 1),
      joined('b', '@terra', 2, 'agent'),
      joined('c', '@codex', 3, 'agent'),
    ];
    expect(Array.from(messages)).toEqual(messages);
  });

  it('keeps each deleted message line in its own place', () => {
    const deleted = (id: string, timestamp: number) => ({
      id,
      text: '@lunchboxfortwo deleted a message · sent by @milo',
      timestamp,
      deleted: true,
      isSystemNotice: true,
      systemEvent: {
        subject: { kind: 'person' as const, id: 'lunchboxfortwo', name: '@lunchboxfortwo' },
        verb: 'deleted',
        object: { text: 'a message' },
        consequence: 'sent by @milo',
      },
    });
    expect(Array.from([deleted('a', 1), deleted('b', 2)]).map((line) => line.id)).toEqual([
      'a',
      'b',
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
    const folded = Array.from([
      joined('a', '@candy', 1),
      message,
      joined('b', '@terra', 3),
      left,
      legacy,
      joined('c', '@codex', 6),
    ]);
    expect(folded.map((row) => row.id)).toEqual(['a', 'm', 'b', 'l', 'old', 'c']);
  });

  it('keeps repeated notices and all recovery details', () => {
    const text =
      'Ruby could not answer · the helper could not authenticate with Claude. Its owner can run beeline connect on its machine.';
    const messages = [
      { id: 'a', timestamp: 1, text, isSystemNotice: true },
      { id: 'b', timestamp: 2, text, isSystemNotice: true },
    ];
    expect(Array.from(messages)).toEqual(messages);
  });
});

it('keeps a corner opened from a message out of a folded lifecycle run', () => {
  const opened = (id: string, timestamp: number, sourceMessageId?: string) => ({
    id,
    text: 'Opened',
    timestamp,
    daemonFact: {
      type: 'corner-open' as const,
      cornerId: `corner-${id}`,
      objective: '',
      name: `corner ${id}`,
      ...(sourceMessageId ? { sourceMessageId } : {}),
    },
  });
  // Lifecycle notices and a source-message marker retain their own anchors.
  const folded = Array.from([opened('a', 1), opened('b', 2), opened('m', 3, 'message')]);
  expect(folded.map((m) => m.id)).toEqual(['a', 'b', 'm']);
});
