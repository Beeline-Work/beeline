import { describe, expect, it } from 'vitest';
import {
  cornerSessionState,
  latestCornerTurnSummary,
  resolveCornerViewAgentPubkey,
} from './corner-session';

describe('corner session presentation', () => {
  it('uses the corner turn lifecycle, not presence, for working, idle, and done', () => {
    expect(cornerSessionState([])).toBe('idle');
    expect(
      cornerSessionState([
        {
          id: 'working',
          text: 'Agent is thinking',
          isUser: false,
          timestamp: 1,
          agentTurn: { requestId: 'turn', agentPubkey: 'agent', status: 'working' },
        },
      ]),
    ).toBe('working');
    expect(
      cornerSessionState([
        {
          id: 'complete',
          text: 'Done',
          isUser: false,
          timestamp: 2,
          agentTurn: { requestId: 'turn', agentPubkey: 'agent', status: 'complete' },
        },
      ]),
    ).toBe('done');
  });

  it('prefers a known registered agent over a stale declared agent-turn pubkey', () => {
    // The most recent `agentTurn` message carries a stale/legacy declared
    // `agent` pubkey ("stale-pk") that no longer resolves on the roster, even
    // though an earlier message in the same transcript is actually signed by
    // the current registered agent ("beebee-pk"). Blindly trusting the
    // declared tag (the pre-fix behavior) resolves to the pubkey-hash
    // fallback name ("Alden") instead of "Beebee".
    const isRegisteredAgent = (pubkey: string) => pubkey === 'beebee-pk';
    const messages = [
      {
        id: 'opened',
        text: 'Corner opened',
        isUser: false,
        timestamp: 1,
        pubkey: 'beebee-pk',
      },
      {
        id: 'turn',
        text: 'Working…',
        isUser: false,
        timestamp: 2,
        agentTurn: { requestId: 'turn', agentPubkey: 'stale-pk', status: 'working' as const },
      },
    ];
    expect(resolveCornerViewAgentPubkey(messages, isRegisteredAgent)).toBe('beebee-pk');
  });

  it('uses the declared agent-turn pubkey when it is itself registered', () => {
    const isRegisteredAgent = (pubkey: string) => pubkey === 'beebee-pk';
    const messages = [
      {
        id: 'turn',
        text: 'Working…',
        isUser: false,
        timestamp: 1,
        agentTurn: { requestId: 'turn', agentPubkey: 'beebee-pk', status: 'working' as const },
      },
    ];
    expect(resolveCornerViewAgentPubkey(messages, isRegisteredAgent)).toBe('beebee-pk');
  });

  it('uses the durable agent reply as the turn summary', () => {
    expect(
      latestCornerTurnSummary([
        { id: 'steer', text: 'Please rename the Room', isUser: true, timestamp: 1 },
        {
          id: 'summary',
          text: 'Renamed the Room and updated its tests.',
          isUser: false,
          timestamp: 2,
        },
      ]),
    ).toBe('Renamed the Room and updated its tests.');
  });
});
