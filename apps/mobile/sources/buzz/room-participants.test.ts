import { describe, expect, it } from 'vitest';

import { countRoomParticipants, formatRoomParticipantCounts } from './room-participants';

describe('Room participant counts', () => {
  it('counts only agents who are direct members of the Room', () => {
    expect(
      countRoomParticipants(
        [{ pubkey: 'human-a' }, { pubkey: 'human-b' }, { pubkey: 'agent-a' }],
        [{ pubkey: 'agent-a' }, { pubkey: 'agent-from-another-room' }],
      ),
    ).toEqual({ humans: 2, agents: 1 });
  });

  it('treats standalone Room members as humans when no agents are registered', () => {
    expect(countRoomParticipants([{ pubkey: 'human-a' }], [])).toEqual({ humans: 1, agents: 0 });
  });

  it('formats a clean person-facing summary without technical identifiers', () => {
    expect(formatRoomParticipantCounts({ humans: 0, agents: 1 })).toBe('0 humans · 1 agent');
  });
});
