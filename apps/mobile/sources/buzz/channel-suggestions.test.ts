import { describe, expect, it } from 'vitest';
import { findChannelReferences, buildChannelReferenceIndex } from './channel-reference';
import {
  activeChannelAtCursor,
  channelSuggestionCandidates,
  filterChannelSuggestions,
  replaceActiveChannel,
} from './channel-suggestions';

const rooms = [
  { id: 'r1', name: 'beeline' },
  { id: 'r2', name: 'experiments' },
  { id: 'r3', name: 'export-logs' },
];
const corners = [
  { id: 'c1', name: 'experiment-flags' },
  { id: 'c2', name: 'composer-handle-chip' },
];

describe('activeChannelAtCursor', () => {
  it('finds a # fragment at a word start, including a room/ prefix', () => {
    expect(activeChannelAtCursor('between #exp', 12)).toEqual({ start: 8, end: 12, query: 'exp' });
    expect(activeChannelAtCursor('#beeline/', 9)).toEqual({ start: 0, end: 9, query: 'beeline/' });
    expect(activeChannelAtCursor('#', 1)).toEqual({ start: 0, end: 1, query: '' });
  });

  it('ignores a # glued to a word and a finished heading mark', () => {
    expect(activeChannelAtCursor('foo#bar', 7)).toBeNull();
    expect(activeChannelAtCursor('# heading', 9)).toBeNull();
  });
});

describe('filterChannelSuggestions', () => {
  const candidates = channelSuggestionCandidates(rooms, { name: 'beeline' }, corners);

  it('lists Rooms and the current Room corners, prefix matches first', () => {
    expect(filterChannelSuggestions(candidates, 'exp').matches.map((item) => item.token)).toEqual([
      'experiments',
      'export-logs',
      'beeline/experiment-flags',
    ]);
  });

  it('lists a Room corners after room/', () => {
    expect(
      filterChannelSuggestions(candidates, 'beeline/').matches.map((item) => item.token),
    ).toEqual(['beeline/experiment-flags', 'beeline/composer-handle-chip']);
  });

  it('caps the list and counts the rest', () => {
    expect(filterChannelSuggestions(candidates, '', 2)).toMatchObject({ overflow: 3 });
  });

  it('offers no corners until their Room is known', () => {
    expect(channelSuggestionCandidates(rooms, null, corners).map((item) => item.kind)).toEqual([
      'room',
      'room',
      'room',
    ]);
  });
});

describe('replaceActiveChannel', () => {
  it('inserts a token the sent message links', () => {
    const text = '@ruby what is the difference between #exp';
    const inserted = replaceActiveChannel(
      text,
      activeChannelAtCursor(text, text.length)!,
      'beeline/experiment-flags',
    );
    expect(inserted).toEqual({
      text: '@ruby what is the difference between #beeline/experiment-flags ',
      cursor: inserted.text.length,
    });
    const index = buildChannelReferenceIndex(
      [{ channelId: 'r1', name: 'beeline' }],
      [{ channelId: 'c1', parentChannelId: 'r1', name: 'experiment-flags' }],
    );
    expect(findChannelReferences(inserted.text, index)[0]?.target).toMatchObject({
      kind: 'corner',
      channelId: 'c1',
    });
  });

  it('adds no second space before existing whitespace', () => {
    const text = '#exp and more';
    expect(replaceActiveChannel(text, activeChannelAtCursor(text, 4)!, 'experiments').text).toBe(
      '#experiments and more',
    );
  });
});
