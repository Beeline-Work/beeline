import { describe, expect, it } from 'vitest';
import {
  cachedChannelKind,
  channelHeaderTitle,
  cornerSessionState,
  cornerProcessState,
  changeReviewSummary,
  resolveCornerViewAgentPubkey,
} from './corner-session';
import { ROOM_LABEL } from './vocabulary';

describe('corner session presentation', () => {
  it('surfaces process state by monotonic sequence', () => {
    const message = (state: 'live' | 'suspended' | 'waiting-for-slot', sequence: number) => ({ id: String(sequence), text: state, isUser: false, timestamp: 1, cornerProcess: { sessionId: 's', agentPubkey: 'a', state, sequence } });
    expect(cornerProcessState([message('live', 3), message('suspended', 1)])).toBe('live');
  });
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

  it('describes the reviewed change, never the turn narration', () => {
    // The review card sits directly above the diff, under a transcript that
    // already carries the agent's prose in full — it names files, not words.
    expect(changeReviewSummary(['apps/body/src/acp.ts'])).toBe('apps/body/src/acp.ts');
    expect(changeReviewSummary(['a.ts', 'b.ts'])).toBe('a.ts, b.ts');
    expect(changeReviewSummary(['a.ts', 'b.ts', 'c.ts', 'd.ts'])).toBe('a.ts, b.ts +2 more');
  });

  it('says nothing at all until the manifest has actually loaded', () => {
    // "not known yet" and "nothing changed" are different answers; the card
    // renders its own neutral line rather than a count it cannot stand behind.
    expect(changeReviewSummary(null)).toBeUndefined();
    expect(changeReviewSummary(undefined)).toBeUndefined();
    expect(changeReviewSummary([])).toBeUndefined();
    expect(changeReviewSummary(['   '])).toBeUndefined();
  });
});

describe('chat header title', () => {
  it('never shows the Room label while a corner is loading', () => {
    // "ROOM" names the wrong surface entirely, and a corner's own name is a
    // slug, so the label is not even a plausible stand-in for it.
    expect(channelHeaderTitle(null, 'corner', 'c0ffee00deadbeef')).toBeNull();
    expect(channelHeaderTitle(null, 'unknown', 'c0ffee00deadbeef')).toBeNull();
    expect(channelHeaderTitle('', 'corner', 'c0ffee00deadbeef')).toBe('corner-c0ffee00');
    expect(channelHeaderTitle('fix oauth callback', 'corner', 'c0ffee00deadbeef')).toBe(
      'fix-oauth-callback',
    );
  });

  it('shows a resolved name, and the Room label only for a confirmed Room', () => {
    expect(channelHeaderTitle('Payments', 'room', 'room-1')).toBe('Payments');
    expect(channelHeaderTitle('  Payments  ', 'room', 'room-1')).toBe('Payments');
    expect(channelHeaderTitle('', 'room', 'room-1')).toBe(ROOM_LABEL);
    expect(channelHeaderTitle(null, 'room', 'room-1')).toBe(ROOM_LABEL);
  });

  it('never returns the Room label for anything but a confirmed Room', () => {
    for (const kind of ['corner', 'unknown'] as const) {
      for (const name of [null, '', 'x'] as const) {
        expect(channelHeaderTitle(name, kind, 'chan-1')).not.toBe(ROOM_LABEL);
      }
    }
  });
});

describe('cached channel kind', () => {
  it('treats a parentless entry as a Room only once its name has been written', () => {
    expect(cachedChannelKind(undefined)).toBe('unknown');
    expect(cachedChannelKind({})).toBe('unknown');
    expect(cachedChannelKind({ roomName: '' })).toBe('unknown');
    expect(cachedChannelKind({ roomName: 'Payments' })).toBe('room');
    expect(cachedChannelKind({ parentChannelId: 'room-1' })).toBe('corner');
    expect(cachedChannelKind({ parentChannelId: 'room-1', roomName: 'fix-oauth' })).toBe('corner');
  });
});
