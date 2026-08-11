import { describe, expect, it } from 'vitest';

import {
  formatRoomParticipantList,
  formatRoomParticipantTotal,
  mentionedAgentPubkey,
} from './room-participants';

describe('Room participant presentation', () => {
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
