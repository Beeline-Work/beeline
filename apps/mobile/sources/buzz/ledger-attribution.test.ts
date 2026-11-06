import { describe, expect, it } from 'vitest';

import { continuedSpeakerIds, ledgerSpeakerKey, type LedgerAttributionMessage } from './ledger-attribution';

const agent = (id: string, pubkey = 'beebee') => ({ id, speaker: `agent:${pubkey}` });
const other = (id: string) => ({ id, speaker: null });

describe('ledger attribution runs', () => {
  it('re-announces a person when switching between a client and direct posting', () => {
    const direct = { id: 'direct', pubkey: 'person' };
    const via = { ...direct, id: 'via', sourceClient: { id: 'grok' } };
    expect(ledgerSpeakerKey(direct, new Set())).not.toBe(ledgerSpeakerKey(via, new Set()));
  });
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

  it('breaks an agent run at a merged corner or PR summary card', () => {
    const pubkey = 'hoots';
    const cards = [
      { daemonFact: { type: 'corner-complete', outcome: 'landed' } },
      { durableFact: { kind: 'merge' } },
      { grantRequest: { id: 'grant' } },
      { squireApproval: { approvalUrl: 'https://trustysquire.test/approve' } },
      { connectorOffer: { offerId: 'offer' } },
      { choice: { choiceId: 'choice' } },
    ];

    for (const [index, card] of cards.entries()) {
      const prose = { id: `answer-${index}`, speaker: `agent:${pubkey}` };
      const continued = continuedSpeakerIds([
        {
          id: `card-${index}`,
          speaker: ledgerSpeakerKey(
            { id: `card-${index}`, pubkey, isAgentActivity: true, ...card },
            new Set([pubkey]),
          ),
        },
        prose,
      ]);

      expect(continued.has(prose.id)).toBe(false);
    }
  });

  it('always announces the first message from a new speaker', () => {
    const knownAgents = new Set(['hoots', 'lumen']);
    const continued = continuedSpeakerIds([
      {
        id: 'hoots-1',
        speaker: ledgerSpeakerKey(
          { id: 'hoots-1', pubkey: 'hoots', isAgentAuthor: true },
          knownAgents,
        ),
      },
      {
        id: 'lumen-1',
        speaker: ledgerSpeakerKey(
          { id: 'lumen-1', pubkey: 'lumen', isAgentAuthor: true },
          knownAgents,
        ),
      },
    ]);

    expect(continued.has('lumen-1')).toBe(false);
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


const AGENT = 'a'.repeat(64);
const OTHER_AGENT = 'b'.repeat(64);
const PERSON = 'c'.repeat(64);
const VIEWER = 'd'.repeat(64);
const ROSTER = new Set([AGENT, OTHER_AGENT]);

function cornerMessage(overrides: Partial<LedgerAttributionMessage>): LedgerAttributionMessage {
  return { id: overrides.id ?? 'm', ...overrides };
}

/** Project a corner transcript to its per-entry speaker keys + runs, exactly
 * as the corner screen does (`continuedSpeakerIds` over `ledgerSpeakerKey`,
 * with collapsed tool/thought rows flagged as machine noise). */
function projectCornerTranscript(messages: readonly LedgerAttributionMessage[]) {
  const keys = new Map(
    messages.map((message) => [message.id, ledgerSpeakerKey(message, ROSTER)] as const),
  );
  const continued = continuedSpeakerIds(
    messages.map((message) => ({
      id: message.id,
      speaker: keys.get(message.id) ?? null,
      isMachine: message.isAgentActivity,
    })),
  );
  return { keys, continued };
}

describe('corner transcript speaker attribution (same treatment as rooms)', () => {
  it('the corner agent’s narration run carries its mark and name once', () => {
    const { keys, continued } = projectCornerTranscript([
      cornerMessage({ id: 'seg-1', pubkey: AGENT, isAgentAuthor: true }),
      cornerMessage({ id: 'seg-2', pubkey: AGENT, isAgentAuthor: true }),
      cornerMessage({ id: 'tool-1', pubkey: AGENT, isAgentActivity: true }),
    ]);
    expect(keys.get('seg-1')).toBe(`agent:${AGENT}`);
    // Continuations of the same voice stay unattributed.
    expect(keys.get('seg-2')).toBe(`agent:${AGENT}`);
    expect(continued.has('seg-2')).toBe(true);
    expect(continued.has('seg-1')).toBe(false);
    // A collapsed tool line opening no new voice stays folded into the run.
    expect(continued.has('tool-1')).toBe(true);
  });

  it('another participant’s steer ends the run and announces itself', () => {
    const { keys, continued } = projectCornerTranscript([
      cornerMessage({ id: 'agent-1', pubkey: AGENT, isAgentAuthor: true }),
      cornerMessage({ id: 'steer', pubkey: PERSON }),
      cornerMessage({ id: 'agent-2', pubkey: AGENT, isAgentAuthor: true }),
    ]);
    expect(keys.get('steer')).toBe(`person:${PERSON}`);
    expect(continued.has('steer')).toBe(false);
    // The agent re-announces on the far side of the interruption.
    expect(continued.has('agent-2')).toBe(false);
  });

  it('two different agents in one corner never fold into one voice', () => {
    const { keys, continued } = projectCornerTranscript([
      cornerMessage({ id: 'ox', pubkey: AGENT, isAgentAuthor: true }),
      cornerMessage({ id: 'peer', pubkey: OTHER_AGENT, isAgentAuthor: true }),
    ]);
    expect(keys.get('ox')).toBe(`agent:${AGENT}`);
    expect(keys.get('peer')).toBe(`agent:${OTHER_AGENT}`);
    expect(continued.has('peer')).toBe(false);
  });

  it('your own steer reads as You and an optimistic send keys on the viewer', () => {
    const { keys } = projectCornerTranscript([
      cornerMessage({ id: 'mine', pubkey: VIEWER, isUser: true }),
      cornerMessage({ id: 'pending', isUser: true }),
    ]);
    expect(keys.get('mine')).toBe(`person:${VIEWER}`);
    expect(keys.get('pending')).toBe('person:self');
  });

  it('an agent known only by the roster still keys as an agent', () => {
    const message = cornerMessage({ id: 'm', pubkey: AGENT });
    expect(ledgerSpeakerKey(message, ROSTER)).toBe(`agent:${AGENT}`);
    // With no roster at all, narration without the agent tag is a person —
    // attributed, never bare.
    expect(ledgerSpeakerKey(message, new Set())).toBe(`person:${AGENT}`);
  });

  it('a tool-summary-then-prose run attributes the prose (owner report 2026-08-23)', () => {
    // A collapsed tool block opening the run carries the compact header, but
    // the agent's actual text turn must still announce itself with mark +
    // name — machine noise cannot spend the prose's byline.
    const { keys, continued } = projectCornerTranscript([
      cornerMessage({ id: 'tool-1', pubkey: AGENT, isAgentActivity: true }),
      cornerMessage({ id: 'prose-1', pubkey: AGENT, isAgentAuthor: true }),
    ]);
    expect(keys.get('tool-1')).toBe(`agent:${AGENT}`);
    expect(continued.has('tool-1')).toBe(false); // compact header on the block
    expect(continued.has('prose-1')).toBe(false); // full byline above the prose
  });

  it('mechanism rows belong to nobody: cards end runs instead of speaking', () => {
    const { keys, continued } = projectCornerTranscript([
      cornerMessage({ id: 'agent-1', pubkey: AGENT, isAgentAuthor: true }),
      cornerMessage({ id: 'card', pubkey: AGENT, corner: { state: 'waiting' } }),
      cornerMessage({ id: 'notice', isSystemNotice: true }),
      cornerMessage({ id: 'permission', writePermission: { status: 'allowed' } }),
      cornerMessage({ id: 'proposal', targetBranchProposal: {} }),
      cornerMessage({ id: 'agent-2', pubkey: AGENT, isAgentAuthor: true }),
    ]);
    for (const id of ['card', 'notice', 'permission', 'proposal']) {
      expect(keys.get(id)).toBeNull();
    }
    expect(continued.has('agent-2')).toBe(false);
  });
});
