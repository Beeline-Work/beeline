import { describe, expect, it } from 'vitest';

import {
  formatRoomParticipantList,
  formatRoomParticipantTotal,
  mentionedAgentPubkey,
  roomParticipantPubkeys,
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
    expect(formatRoomParticipantTotal(1)).toBe('1 participant');
    expect(formatRoomParticipantTotal(8)).toBe('8 participants');
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
});
