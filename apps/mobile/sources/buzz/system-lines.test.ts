import { describe, expect, it } from 'vitest';
import { anchorRelayReports, joinSystemNames, systemLineText } from './system-lines';

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
    expect(anchorRelayReports(messages)).toEqual(messages);
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
    expect(anchorRelayReports([deleted('a', 1), deleted('b', 2)]).map((line) => line.id)).toEqual([
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
    const folded = anchorRelayReports([
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

  it('keeps repeated notices and all recovery details', () => {
    const text =
      'Ruby could not answer · the helper could not authenticate with Claude. Its owner can run beeline connect on its machine.';
    const messages = [
      { id: 'a', timestamp: 1, text, isSystemNotice: true },
      { id: 'b', timestamp: 2, text, isSystemNotice: true },
    ];
    expect(anchorRelayReports(messages)).toEqual(messages);
  });
});

it('anchors up-relays below their corner card and keeps an unanchored report visible', () => {
  const card = {
    id: 'card',
    text: 'Opened',
    timestamp: 1,
    daemonFact: {
      type: 'corner-open' as const,
      cornerId: 'c',
      objective: 'Work',
      name: 'Work',
    },
  };
  const report = {
    id: 'report',
    text: 'Ready',
    timestamp: 3,
    relay: { direction: 'up' as const, anchorMessageId: 'card' },
  };
  const middle = { id: 'middle', text: 'Other conversation', timestamp: 2 };
  const folded = anchorRelayReports([card, middle, report]);
  expect(folded.map((m) => m.id)).toEqual(['card', 'middle']);
  expect(folded[0]).toMatchObject({ relayReports: [report] });
  // A newly unread report still belongs under a previously read corner card.
  const anchored = anchorRelayReports([card, middle, report]);
  const boundary = anchored.findIndex(
    (m) => m.id === report.id || m.relayReports?.some((r) => r.id === report.id),
  );
  expect(boundary).toBe(0);
  expect([
    ...anchorRelayReports(anchored.slice(0, boundary)),
    ...anchorRelayReports(anchored.slice(boundary)),
  ]).toEqual(folded);
  expect(anchorRelayReports([middle, report])).toEqual([middle, report]);
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
  const folded = anchorRelayReports([opened('a', 1), opened('b', 2), opened('m', 3, 'message')]);
  expect(folded.map((m) => m.id)).toEqual(['a', 'b', 'm']);
  expect(folded.every((row) => !row.notificationLifecycleRun)).toBe(true);
  expect(folded[1]!.notificationLifecycleRun).toBeUndefined();
});
