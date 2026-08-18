import { describe, expect, it } from 'vitest';

import { continuedSpeakerIds } from './ledger-attribution';

const agent = (id: string, pubkey = 'beebee') => ({ id, speaker: `agent:${pubkey}` });
const other = (id: string) => ({ id, speaker: null });

describe('ledger attribution runs', () => {
  it('announces a voice once, then lets it keep writing', () => {
    const continued = continuedSpeakerIds([agent('a1'), agent('a2'), agent('a3')]);
    expect(continued.has('a1')).toBe(false);
    expect([...continued]).toEqual(['a2', 'a3']);
  });

  it('makes an agent re-announce itself after someone else speaks', () => {
    const continued = continuedSpeakerIds([agent('a1'), other('human'), agent('a2')]);
    expect(continued.size).toBe(0);
  });

  it('keeps two agents in the same Room distinguishable', () => {
    const continued = continuedSpeakerIds([
      agent('a1', 'beebee'),
      agent('b1', 'alden'),
      agent('b2', 'alden'),
      agent('a2', 'beebee'),
    ]);
    expect([...continued]).toEqual(['b2']);
  });

  it('never treats an unattributed row as a continuation of another', () => {
    // Two system rows in a row are both "no voice" — neither may be folded into
    // the other, and neither may swallow the next agent's announcement.
    const continued = continuedSpeakerIds([other('card-1'), other('card-2'), agent('a1')]);
    expect(continued.size).toBe(0);
  });
});
