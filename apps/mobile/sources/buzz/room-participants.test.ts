import { describe, expect, it } from 'vitest';

import {
  activeMentionAtCursor,
  filterMentionCandidates,
  formatRoomParticipantList,
  formatRoomParticipantTotal,
  mentionedAgentPubkey,
  replaceActiveMention,
  resolveComposerMentions,
  selectedMentionPubkeys,
  sectionRoomParticipants,
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
    expect(formatRoomParticipantTotal(1)).toBe('1 member');
    expect(formatRoomParticipantTotal(3)).toBe('3 members');
    expect(formatRoomParticipantTotal(8)).toBe('8 members');
  });

  it('groups the visible Room roster into people and Agents', () => {
    const participants = [
      { pubkey: 'person-a', kind: 'person' as const },
      { pubkey: 'agent-a', kind: 'agent' as const },
      { pubkey: 'person-b', kind: 'person' as const },
    ];

    expect(sectionRoomParticipants(participants)).toEqual({
      people: [participants[0], participants[2]],
      agents: [participants[1]],
    });
  });

  it('maps a visible @Agent name to its pubkey without partial-name matches', () => {
    const agents = [
      { pubkey: 'agent-a', name: 'Brisk Pilot', handle: 'brisk-pilot' },
      { pubkey: 'agent-b', name: 'Brisk', handle: 'brisk' },
    ];
    expect(mentionedAgentPubkey('please ask @Brisk Pilot to inspect this', agents)).toBe('agent-a');
    expect(mentionedAgentPubkey('hello @brisk!', agents)).toBe('agent-b');
    expect(mentionedAgentPubkey('hello @brisk-pilot!', agents)).toBe('agent-a');
    expect(mentionedAgentPubkey('email @briskness later', agents)).toBeUndefined();
  });

  it('keeps every selected person or agent mention that remains in the sent text', () => {
    const selections = new Map([
      ['alan', 'human-alan'],
      ['codex', 'agent-codex'],
      ['ann', 'human-ann'],
    ]);

    expect(selectedMentionPubkeys('Ask @alan and @codex, not @annette', selections)).toEqual([
      'human-alan',
      'agent-codex',
    ]);
  });

  it('resolves manually completed human and agent handles to wire-ready member pubkeys', () => {
    const participants = [
      { pubkey: 'human-alan', name: 'Alan', handle: 'alan' },
      { pubkey: 'agent-codex', name: 'Codex', handle: 'codex' },
    ];

    expect(resolveComposerMentions('Ask @alan and @codex', participants, new Map())).toEqual({
      pubkeys: ['human-alan', 'agent-codex'],
      handles: ['alan', 'codex'],
    });
  });

  it('resolves the owner typed @codex message against the visible name in a two-agent roster', () => {
    const participants = [
      { pubkey: 'agent-ox', name: 'Ox', handle: 'ox' },
      // The server identity can retain a distinct canonical handle while the
      // current roster presentation resolves the agent's visible name.
      { pubkey: 'agent-codex', name: 'Codex', handle: 'codex-7f3a' },
    ];

    expect(
      resolveComposerMentions(
        '@codex if any of the corners are working, see if they need anything',
        participants,
        new Map(),
      ),
    ).toEqual({
      pubkeys: ['agent-codex'],
      handles: ['codex'],
    });
  });

  it('keeps unknown or ambiguous tokens ordinary instead of presenting a false mention', () => {
    const participants = [
      { pubkey: 'first-alan', name: 'Alan One', handle: 'alan' },
      { pubkey: 'second-alan', name: 'Alan Two', handle: 'alan' },
    ];

    expect(resolveComposerMentions('@unknown and @alan', participants, new Map())).toEqual({
      pubkeys: [],
      handles: [],
    });
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
