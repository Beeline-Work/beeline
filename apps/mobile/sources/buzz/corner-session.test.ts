import { describe, expect, it } from 'vitest';
import {
  cachedChannelKind,
  channelHeaderTitle,
  cornerSessionState,
  cornerProcessState,
  resolveCornerViewAgentPubkey,
} from './corner-session';
import { ROOM_LABEL } from './vocabulary';

describe('corner session presentation', () => {
  it('surfaces process state by monotonic sequence', () => {
    const message = (state: 'live' | 'suspended' | 'waiting-for-slot', sequence: number) => ({
      id: String(sequence),
      text: state,
      isUser: false,
      timestamp: 1,
      cornerProcess: { sessionId: 's', agentPubkey: 'a', state, sequence },
    });
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

});

describe('chat header title (the # channel-mark convention)', () => {
  it('never shows the Room label while a corner is loading', () => {
    // "ROOM" names the wrong surface entirely, and a corner's own name is a
    // slug, so the label is not even a plausible stand-in for it.
    expect(channelHeaderTitle(null, 'corner', 'c0ffee00deadbeef')).toBeNull();
    expect(channelHeaderTitle(null, 'unknown', 'c0ffee00deadbeef')).toBeNull();
  });

  it('renders a corner as #<room>/<corner> when the parent Room name is known', () => {
    expect(
      channelHeaderTitle('fix oauth callback', 'corner', 'c0ffee00deadbeef', {
        parentRoomName: 'Payments',
      }),
    ).toBe('#Payments/fix-oauth-callback');
  });

  it('degrades a corner to the honest #<corner> while the parent name is unresolved', () => {
    expect(channelHeaderTitle('fix oauth callback', 'corner', 'c0ffee00deadbeef')).toBe(
      '#fix-oauth-callback',
    );
    expect(
      channelHeaderTitle('fix oauth callback', 'corner', 'c0ffee00deadbeef', {
        parentRoomName: null,
      }),
    ).toBe('#fix-oauth-callback');
    // A corner with no stored name falls through to the id slug — marked,
    // never empty, and never the word "Room".
    expect(
      channelHeaderTitle('', 'corner', 'c0ffee00deadbeef', { parentRoomName: 'Payments' }),
    ).toBe('#Payments/corner-c0ffee00');
  });

  it('never double-prefixes an already-marked stored name', () => {
    expect(channelHeaderTitle('#Payments', 'room', 'room-1')).toBe('#Payments');
    expect(
      channelHeaderTitle('fix oauth callback', 'corner', 'c0ffee00deadbeef', {
        parentRoomName: '#Payments',
      }),
    ).toBe('#Payments/fix-oauth-callback');
  });

  it('marks a confirmed Room name, keeps the skeleton, and spares the generic label', () => {
    expect(channelHeaderTitle('Payments', 'room', 'room-1')).toBe('#Payments');
    expect(channelHeaderTitle('  Payments  ', 'room', 'room-1')).toBe('#Payments');
    expect(channelHeaderTitle('', 'room', 'room-1')).toBe(ROOM_LABEL);
    expect(channelHeaderTitle(null, 'room', 'room-1')).toBe(ROOM_LABEL);
    // A DM's title is its peer's identity — a person, never a place.
    expect(channelHeaderTitle('beebee', 'room', 'dm-1', { directMessage: true })).toBe('beebee');
    // A cached name that landed before the kind resolved keeps the legacy
    // plain shape rather than guessing which mark form applies.
    expect(channelHeaderTitle('Payments', 'unknown', 'room-1')).toBe('Payments');
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
