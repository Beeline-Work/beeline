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

  it('re-announces the voice when prose follows a collapsed tool run', () => {
    // Owner-reported (peddle room, 2026-08-23): a run ordered [tool-summary,
    // prose] spent the byline on the tool block and left the agent's actual
    // text turn bare — the reader could not tell who was talking. Machine
    // noise opens a run but cannot lend its continuation to the prose below.
    const tool = { id: 'tool-1', speaker: 'agent:beebee', isMachine: true };
    const prose = agent('a1');
    const continued = continuedSpeakerIds([tool, prose]);
    expect(continued.has('tool-1')).toBe(false);
    expect(continued.has('a1')).toBe(false);
  });

  it('still folds machine rows that follow their own prose', () => {
    // A reply followed by its collapsed tool line is one run: no repeated
    // compact header under the byline the prose already carried.
    const continued = continuedSpeakerIds([
      agent('a1'),
      { id: 'tool-1', speaker: 'agent:beebee', isMachine: true },
      { id: 'tool-2', speaker: 'agent:beebee', isMachine: true },
    ]);
    expect([...continued]).toEqual(['tool-1', 'tool-2']);
  });

  it('prose after a mid-run tool block re-announces instead of riding the earlier byline past the block', () => {
    const continued = continuedSpeakerIds([
      agent('a1'),
      { id: 'tool-1', speaker: 'agent:beebee', isMachine: true },
      agent('a2'),
    ]);
    expect(continued.has('tool-1')).toBe(true);
    expect(continued.has('a2')).toBe(false);
  });

  it('machine noise never bridges two different voices', () => {
    const continued = continuedSpeakerIds([
      agent('a1', 'beebee'),
      { id: 'tool-1', speaker: 'agent:beebee', isMachine: true },
      agent('b1', 'alden'),
    ]);
    expect(continued.has('b1')).toBe(false);
  });

  it('a reply re-announces its speaker even when the same voice sent the entry above (screenshot 97520a1e)', () => {
    // Two consecutive Ox messages: the second carries a reply-reference (it
    // quotes an earlier message, not the one directly above it) and was
    // byline-suppressed by the plain run-continuation rule, which made it
    // read as authored by whoever it quoted instead of by Ox.
    const continued = continuedSpeakerIds([
      agent('ox-1', 'ox'),
      { ...agent('ox-2', 'ox'), hasReplyReference: true },
    ]);
    expect(continued.has('ox-2')).toBe(false);
  });

  it('a reply never re-opens a run for the entries that follow it', () => {
    const continued = continuedSpeakerIds([
      agent('ox-1', 'ox'),
      { ...agent('ox-2', 'ox'), hasReplyReference: true },
      agent('ox-3', 'ox'),
    ]);
    expect(continued.has('ox-2')).toBe(false);
    expect(continued.has('ox-3')).toBe(true);
  });

  it('a reply that opens a brand-new voice still shows its byline (nothing new to prove, but never regress)', () => {
    const continued = continuedSpeakerIds([
      agent('a1', 'beebee'),
      { ...agent('b1', 'alden'), hasReplyReference: true },
    ]);
    expect(continued.has('b1')).toBe(false);
  });
});
