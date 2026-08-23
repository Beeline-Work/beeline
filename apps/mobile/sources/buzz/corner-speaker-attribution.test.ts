import { describe, expect, it } from 'vitest';
import {
  continuedSpeakerIds,
  ledgerSpeakerKey,
  type LedgerAttributionMessage,
} from './ledger-attribution';

const AGENT = 'a'.repeat(64);
const OTHER_AGENT = 'b'.repeat(64);
const PERSON = 'c'.repeat(64);
const VIEWER = 'd'.repeat(64);
const ROSTER = new Set([AGENT, OTHER_AGENT]);

function cornerMessage(overrides: Partial<LedgerAttributionMessage>): LedgerAttributionMessage {
  return { id: overrides.id ?? 'm', ...overrides };
}

/** Project a corner transcript to its per-entry speaker keys + runs, exactly
 * as the corner screen does (`continuedSpeakerIds` over `ledgerSpeakerKey`). */
function projectCornerTranscript(messages: readonly LedgerAttributionMessage[]) {
  const keys = new Map(
    messages.map((message) => [message.id, ledgerSpeakerKey(message, ROSTER)] as const),
  );
  const continued = continuedSpeakerIds(
    messages.map((message) => ({ id: message.id, speaker: keys.get(message.id) ?? null })),
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

  it('mechanism rows belong to nobody: cards end runs instead of speaking', () => {
    const { keys, continued } = projectCornerTranscript([
      cornerMessage({ id: 'agent-1', pubkey: AGENT, isAgentAuthor: true }),
      cornerMessage({ id: 'card', pubkey: AGENT, corner: { status: 'open' } }),
      cornerMessage({ id: 'notice', isSystemNotice: true }),
      cornerMessage({ id: 'merge', isMergeSummary: true }),
      cornerMessage({ id: 'permission', writePermission: { status: 'allowed' } }),
      cornerMessage({ id: 'proposal', targetBranchProposal: {} }),
      cornerMessage({ id: 'agent-2', pubkey: AGENT, isAgentAuthor: true }),
    ]);
    for (const id of ['card', 'notice', 'merge', 'permission', 'proposal']) {
      expect(keys.get(id)).toBeNull();
    }
    expect(continued.has('agent-2')).toBe(false);
  });
});
