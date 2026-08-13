import { describe, expect, it } from 'vitest';

import {
  activeMentionAtCursor,
  filterMentionCandidates,
  formatRoomParticipantList,
  formatRoomParticipantTotal,
  mentionedAgentPubkey,
  replaceActiveMention,
  roomParticipantPubkeys,
  sectionRoomRoster,
} from './room-participants';

describe('Room participant presentation', () => {
  it('sections the Workspace roster with current Room members first', () => {
    const roster = [
      { pubkey: 'you', name: 'You' },
      { pubkey: 'agent', name: 'Brisk Pilot' },
      { pubkey: 'person', name: 'npub1person' },
    ];

    expect(sectionRoomRoster(roster, new Set(['agent', 'you']))).toEqual({
      inRoom: [roster[0], roster[1]],
      addable: [roster[2]],
    });
  });

  it('shows up to five names without splitting people and agents', () => {
    expect(formatRoomParticipantList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C, D, E');
  });

  it('folds larger Rooms into four names plus one overflow phrase', () => {
    expect(formatRoomParticipantList(['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toBe(
      'A, B, C, D and 3 others',
    );
  });

  it('formats the compact header total', () => {
    expect(formatRoomParticipantTotal(1)).toBe('1 participant');
    expect(formatRoomParticipantTotal(8)).toBe('8 participants');
  });

  it('excludes Room-only infrastructure identities from the participant roster', () => {
    const roomMembers = new Set(['human', 'agent', 'merge-worker']);

    expect([
      ...roomParticipantPubkeys(roomMembers, [{ pubkey: 'human' }], [{ pubkey: 'agent' }]),
    ]).toEqual(['human', 'agent']);
  });

  it('counts direct Room membership when there is no Workspace roster', () => {
    expect([...roomParticipantPubkeys(new Set(['human', 'guest']))]).toEqual(['human', 'guest']);
  });

  it('maps a visible @Agent name to its pubkey without partial-name matches', () => {
    const agents = [
      { pubkey: 'agent-a', name: 'Brisk Pilot' },
      { pubkey: 'agent-b', name: 'Brisk' },
    ];
    expect(mentionedAgentPubkey('please ask @Brisk Pilot to inspect this', agents)).toBe('agent-a');
    expect(mentionedAgentPubkey('hello @brisk!', agents)).toBe('agent-b');
    expect(mentionedAgentPubkey('email @briskness later', agents)).toBeUndefined();
  });

  it('finds a mention at the cursor without treating emails or word-internal @ as mentions', () => {
    expect(activeMentionAtCursor('@li', 3)).toEqual({ start: 0, end: 3, query: 'li' });
    expect(activeMentionAtCursor('ask (@li about it', 8)).toEqual({
      start: 5,
      end: 8,
      query: 'li',
    });
    expect(activeMentionAtCursor('mail a@li', 9)).toBeNull();
    expect(activeMentionAtCursor('word@li', 7)).toBeNull();
    expect(activeMentionAtCursor('@li later', 9)).toBeNull();
  });

  it('ranks prefix matches before substring matches and reports capped overflow', () => {
    const candidates = [
      { name: 'Alice', handle: 'alice' },
      { name: 'Elio', handle: 'elio' },
      { name: 'Lina', handle: 'lina' },
    ];

    expect(filterMentionCandidates(candidates, 'li', 2)).toEqual({
      matches: [candidates[2], candidates[0]],
      overflow: 1,
    });
  });

  it('replaces the mention fragment at the cursor without disturbing trailing text', () => {
    expect(
      replaceActiveMention('Ask @li tomorrow', { start: 4, end: 7, query: 'li' }, 'lina'),
    ).toEqual({ text: 'Ask @lina tomorrow', cursor: 9 });
  });
});
