import { describe, expect, it } from 'vitest';

import {
  buildChannelReferenceIndex,
  findChannelReferences,
  type ChannelReferenceCornerInput,
  type ChannelReferenceRoomInput,
} from './channel-reference';

const rooms: ChannelReferenceRoomInput[] = [
  { channelId: 'room-roadmap', name: 'Roadmap' },
  { channelId: 'room-infra', name: 'infra' },
  { channelId: 'room-punct', name: 'bugs & fixes' },
  { channelId: 'room-meta', name: 'v1.2 (draft)' },
];

const corners: ChannelReferenceCornerInput[] = [
  { channelId: 'corner-fix', parentChannelId: 'room-roadmap', name: 'fix-relay' },
  { channelId: 'corner-deploy', parentChannelId: 'room-infra', name: 'deploy-watch' },
];

const index = buildChannelReferenceIndex(rooms, corners);

function targets(text: string, at = index) {
  return findChannelReferences(text, at);
}

describe('buildChannelReferenceIndex', () => {
  it('drops empty names and dedupes by channel id (first wins)', () => {
    const built = buildChannelReferenceIndex(
      [
        { channelId: 'a', name: 'First' },
        { channelId: 'a', name: 'Second' },
        { channelId: 'b', name: '   ' },
      ],
      [{ channelId: 'c', parentChannelId: 'b', name: 'orphan' }],
    );
    expect(built.rooms).toEqual([{ channelId: 'a', name: 'First' }]);
    // A corner whose parent Room is not in the index can never be written
    // through a room name — it is skipped outright.
    expect(built.corners).toEqual([]);
  });

  it('resolves the corner room name through its indexed parent', () => {
    expect(index.corners[0]).toMatchObject({
      channelId: 'corner-fix',
      roomName: 'Roadmap',
    });
  });
});

describe('findChannelReferences — known references resolve exactly', () => {
  it('links a known room reference and reports exact offsets', () => {
    const text = 'discuss in #Roadmap please';
    expect(targets(text)).toEqual([
      {
        text: '#Roadmap',
        start: 11,
        end: 19,
        target: { kind: 'room', channelId: 'room-roadmap' },
      },
    ]);
  });

  it('links a known corner reference as a corner with its parent', () => {
    const text = 'see #infra/deploy-watch for status';
    expect(targets(text)).toEqual([
      {
        text: '#infra/deploy-watch',
        start: 4,
        end: 23,
        target: { kind: 'corner', channelId: 'corner-deploy', parentChannelId: 'room-infra' },
      },
    ]);
  });

  it('matches case-insensitively but preserves the authored characters', () => {
    const text = '#ROADMAP and #roadmap are the same place';
    const found = targets(text);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ text: '#ROADMAP', start: 0, end: 8 });
    expect(found[1]).toMatchObject({ text: '#roadmap', start: 13, end: 21 });
    for (const match of found) {
      expect(text.slice(match.start, match.end)).toBe(match.text);
    }
  });
});

describe('findChannelReferences — unknown tokens stay ordinary text', () => {
  it('never links an unknown token', () => {
    expect(targets('no such #nowhere channel')).toEqual([]);
  });

  it('never links a known room name without the # mark', () => {
    expect(targets('the Roadmap room is quiet')).toEqual([]);
  });

  it('does not link a corner-shaped token whose corner is unknown', () => {
    // The room alone must NOT degrade into a link plus "/unknown" text.
    expect(targets('#infra/unknown-corner stays plain')).toEqual([]);
  });

  it('does not link a token from another workspace (absent from this index)', () => {
    const otherWorkspace = buildChannelReferenceIndex(
      [{ channelId: 'elsewhere', name: 'Design' }],
      [],
    );
    expect(targets('look at #Design over there')).toEqual([]);
    expect(findChannelReferences('#Design', otherWorkspace)).toEqual([
      {
        text: '#Design',
        start: 0,
        end: 7,
        target: { kind: 'room', channelId: 'elsewhere' },
      },
    ]);
  });
});

describe('findChannelReferences — ambiguity never guesses', () => {
  it('links nothing when duplicate display names map to two rooms', () => {
    const dupes = buildChannelReferenceIndex(
      [
        { channelId: 'room-1', name: 'General' },
        { channelId: 'room-2', name: 'general' },
      ],
      [],
    );
    expect(findChannelReferences('#general', dupes)).toEqual([]);
    // Same-length candidates pointing at DIFFERENT channels are ambiguous;
    // the same channel appearing twice in the index is not.
    const sameRoomTwice = buildChannelReferenceIndex(
      [
        { channelId: 'room-1', name: 'General' },
        { channelId: 'room-1', name: 'General' },
      ],
      [],
    );
    expect(findChannelReferences('#General', sameRoomTwice)).toHaveLength(1);
  });

  it('prefers the longest complete reference when the shorter one also exists', () => {
    // A unique #room/corner must win over its #room prefix.
    const text = 'start at #Roadmap/fix-relay now';
    const found = targets(text);
    expect(found).toEqual([
      {
        text: '#Roadmap/fix-relay',
        start: 9,
        end: 27,
        target: { kind: 'corner', channelId: 'corner-fix', parentChannelId: 'room-roadmap' },
      },
    ]);
  });

  it('resolves a bare #room even when that room also has corners', () => {
    expect(targets('#Roadmap')[0]?.target).toEqual({ kind: 'room', channelId: 'room-roadmap' });
  });
});

describe('findChannelReferences — names with punctuation and regex metacharacters', () => {
  it('matches names containing regex metacharacters literally', () => {
    const nasty = buildChannelReferenceIndex(
      [{ channelId: 'room-nasty', name: 'c++ (tips) & $tricks.*[x]' }],
      [],
    );
    const text = 'posted in #c++ (tips) & $tricks.*[x] today';
    const found = findChannelReferences(text, nasty);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ start: 10, end: 36 });
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe('#c++ (tips) & $tricks.*[x]');
  });

  it('matches names containing spaces and ampersands', () => {
    const found = targets('file under #bugs & fixes');
    expect(found).toEqual([
      {
        text: '#bugs & fixes',
        start: 11,
        end: 24,
        target: { kind: 'room', channelId: 'room-punct' },
      },
    ]);
  });

  it('matches names containing dots and parens, ending at sentence punctuation', () => {
    const text = '#v1.2 (draft). Ship it.';
    const found = targets(text);
    expect(found).toHaveLength(1);
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe('#v1.2 (draft)');
    expect(found[0]!.target).toEqual({ kind: 'room', channelId: 'room-meta' });
  });
});

describe('findChannelReferences — boundaries', () => {
  it('requires a non-word character before the #', () => {
    expect(targets('foo#Roadmap bar')).toEqual([]);
    expect(targets('abc123#Roadmap')).toEqual([]);
    expect(targets('a/b#Roadmap')).toEqual([]);
  });

  it('links after whitespace or opening punctuation', () => {
    expect(targets('(see #Roadmap)')[0]?.target).toEqual({
      kind: 'room',
      channelId: 'room-roadmap',
    });
    expect(targets('over\n#Roadmap next')[0]?.target).toEqual({
      kind: 'room',
      channelId: 'room-roadmap',
    });
  });

  it('rejects a match whose token continues past the name', () => {
    // "Roadmap" is known but "#Roadmap-extended" is a longer authored token
    // that resolves to nothing; linking the prefix would slice it apart.
    expect(targets('#Roadmap-extended')).toEqual([]);
    expect(targets('#Roadmap2')).toEqual([]);
  });

  it('allows closing punctuation after a match', () => {
    expect(targets('#Roadmap.')[0]?.end).toBe(8);
    expect(targets('#Roadmap, right?')[0]?.end).toBe(8);
    expect(targets('"#Roadmap"')[0]?.end).toBe(9);
  });

  it('suppresses a room link when / follows (an unresolved corner shape)', () => {
    expect(targets('#Roadmap/something-else')).toEqual([]);
    // Even trailing-slash noise suppresses rather than half-links.
    expect(targets('#Roadmap/')).toEqual([]);
  });

  it('finds multiple independent references in one message', () => {
    const text = '#Roadmap then #infra/deploy-watch then #nowhere';
    expect(targets(text)).toEqual([
      { text: '#Roadmap', start: 0, end: 8, target: { kind: 'room', channelId: 'room-roadmap' } },
      {
        text: '#infra/deploy-watch',
        start: 14,
        end: 33,
        target: { kind: 'corner', channelId: 'corner-deploy', parentChannelId: 'room-infra' },
      },
    ]);
  });

  it('handles adjacent references separated only by punctuation', () => {
    const text = '#Roadmap,#infra';
    const found = targets(text);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ start: 0, end: 8 });
    expect(found[1]).toMatchObject({ start: 9, end: 15 });
  });

  it('returns nothing for empty input or an empty index', () => {
    expect(targets('')).toEqual([]);
    expect(targets('#Roadmap', buildChannelReferenceIndex([], []))).toEqual([]);
  });

  it('is safe against pathological inputs (no catastrophic scanning)', () => {
    const longText = '#'.repeat(2000) + 'Roadmap '.repeat(500);
    const started = Date.now();
    const found = targets(longText);
    // '#' before '#' is blocked, so none of the run links.
    expect(found).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
