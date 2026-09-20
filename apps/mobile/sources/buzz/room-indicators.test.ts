import { describe, expect, it } from 'vitest';
import type { RoomViewAgentTurn } from '@beeline/buzz-client';
import {
  COMPOSER_ACK_BOUND_MS,
  hasComposerAckReceipt,
  isPinnedCornerLive,
  isPinnedCornerReadyForReview,
  humanBranchName,
  selectComposerAckState,
  selectComposerAckPresentation,
  viewerMayStopTurn,
  selectTurnProgressAgentPubkey,
  selectWorkingAgents,
} from './room-indicators';

describe('corner-state presentation', () => {
  it('spends gold only on canonical working', () => {
    expect(isPinnedCornerLive('working')).toBe(true);
    expect(isPinnedCornerLive('waiting')).toBe(false);
    expect(isPinnedCornerLive('review')).toBe(false);
    expect(isPinnedCornerLive('archived')).toBe(false);
  });

  it('recognizes only the canonical review display state', () => {
    expect(isPinnedCornerReadyForReview('review')).toBe(true);
    expect(isPinnedCornerReadyForReview('working')).toBe(false);
    expect(isPinnedCornerReadyForReview('waiting')).toBe(false);
  });

  it('shows a human branch name instead of a raw Git ref', () => {
    expect(humanBranchName('refs/heads/main')).toBe('main');
    expect(humanBranchName('refs/heads/release/2026-08')).toBe('release/2026-08');
    expect(humanBranchName('feature/already-short')).toBe('feature/already-short');
  });
});

describe('turn-progress presentation', () => {
  it('lights a Corner from a bare working receipt without consulting Corner session state', () => {
    expect(
      selectTurnProgressAgentPubkey({
        isCorner: true,
        activeTurnPubkey: 'corner-agent',
      }),
    ).toBe('corner-agent');
  });

  it('lights a Room from the claim receipt even when the whole Room reads offline', () => {
    // A stale presence lease is not a veto (C77): the helper renews its lease
    // every 30s, so a Room whose every agent reads offline is one whose lease
    // heartbeats lapsed — and the server-indexed WORKING receipt written at
    // the CLAIM is better evidence than the lease. The receipt's own bounds
    // (90s freshness, explicit offline marker, daemon generation) are the
    // only vetoes, and they live upstream in `isAgentTurnActive`.
    expect(
      selectTurnProgressAgentPubkey({
        isCorner: false,
        activeTurnPubkey: 'room-agent',
      }),
    ).toBe('room-agent');
  });

  it('stays dark without a working receipt, regardless of draft-stream state', () => {
    expect(selectTurnProgressAgentPubkey({ isCorner: true })).toBeNull();
  });
});

describe('working agents (the gold ring)', () => {
  // C77: the ring means working. A presence lease is not an input at all —
  // Candy's helper renewed its lease every few seconds while every turn it
  // took ended `failed`, and the ring pulsed the whole time.
  it('lights the agent named by the fresh working receipt', () => {
    expect(selectWorkingAgents({ activeTurnPubkeys: ['candy'] })).toEqual({ candy: true });
  });

  it('lights every agent whose turn is running: two concurrent answers, two rings', () => {
    expect(selectWorkingAgents({ activeTurnPubkeys: ['goosy', 'terra'] })).toEqual({
      goosy: true,
      terra: true,
    });
  });

  it('lights the administering agent of a working corner', () => {
    expect(selectWorkingAgents({ workingCornerAgentPubkey: 'candy' })).toEqual({ candy: true });
  });

  it('lights nobody when no turn and no corner is live, whatever presence says', () => {
    expect(selectWorkingAgents({})).toEqual({});
    expect(selectWorkingAgents({ activeTurnPubkeys: [], workingCornerAgentPubkey: null })).toEqual(
      {},
    );
  });

  it('never takes a presence lease as proof', () => {
    // The input shape has no presence field; a caller cannot feed one.
    const keys: (keyof Parameters<typeof selectWorkingAgents>[0])[] = [
      'activeTurnPubkeys',
      'workingCornerAgentPubkey',
    ];
    expect(keys).toHaveLength(2);
  });
});

describe('composer ack presentation', () => {
  const NOW = 1_000_000;

  it('renders nothing when nothing was sent and no turn is running', () => {
    expect(selectComposerAckState({ isCorner: false, now: NOW })).toBeNull();
  });

  it('buzzes immediately once a message is sent, before any receipt exists', () => {
    expect(
      selectComposerAckState({
        isCorner: false,
        pendingAckSentAt: NOW,
        now: NOW,
      }),
    ).toEqual({ kind: 'buzzing' });
  });

  it('keeps buzzing right up to the bound', () => {
    expect(
      selectComposerAckState({
        isCorner: false,
        pendingAckSentAt: NOW,
        now: NOW + COMPOSER_ACK_BOUND_MS - 1,
      }),
    ).toEqual({ kind: 'buzzing' });
  });

  it('expires once the bound elapses with no receipt', () => {
    expect(
      selectComposerAckState({
        isCorner: false,
        pendingAckSentAt: NOW,
        now: NOW + COMPOSER_ACK_BOUND_MS,
      }),
    ).toBeNull();
  });

  it('the real receipt always replaces a pending local ack, never races it', () => {
    expect(
      selectComposerAckState({
        isCorner: false,
        pendingAckSentAt: NOW,
        activeTurnPubkey: 'agent-1',
        now: NOW + COMPOSER_ACK_BOUND_MS + 5_000,
      }),
    ).toEqual({ kind: 'thinking', agentPubkey: 'agent-1' });
  });

  it('keeps the visibly synthetic name when the active agent has no server identity', () => {
    const pubkey = '54f4d261'.padEnd(64, '0');

    expect(
      selectComposerAckPresentation({
        isCorner: true,
        activeTurnPubkey: pubkey,
        now: NOW,
        conversationIdentities: new Map(),
      }),
    ).toEqual({ label: 'Agent thinking…' });
  });

  it('offers the stop only to the person who asked, and never on the sending… bridge', () => {
    const agent = 'aa'.repeat(32);
    const asker = 'bb'.repeat(32);
    const bystander = 'cc'.repeat(32);
    const turn = {
      // A Corner's channel-local receipt is presented through the same
      // requester-only control as a Room's; its parent request does not
      // weaken that authority at the phone boundary.
      isCorner: true,
      activeTurnPubkey: agent,
      activeTurnAgentPubkey: agent,
      activeTurnRequestId: 'ask-1',
      activeTurnStartedAt: NOW / 1_000,
      activeTurnRequestedBy: asker,
      now: NOW,
    } as const;

    expect(selectComposerAckPresentation({ ...turn, viewerPubkey: asker })?.stop).toEqual({
      agentPubkey: agent,
      requestId: 'ask-1',
    });
    // Everyone else is a spectator, whatever their standing in the Workspace.
    expect(
      selectComposerAckPresentation({ ...turn, viewerPubkey: bystander })?.stop,
    ).toBeUndefined();
    // Both halves must be known: an unattributed turn offers the control to
    // nobody rather than to everybody.
    expect(
      selectComposerAckPresentation({
        ...turn,
        activeTurnRequestedBy: undefined,
        viewerPubkey: asker,
      })?.stop,
    ).toBeUndefined();
    expect(
      selectComposerAckPresentation({ ...turn, viewerPubkey: undefined })?.stop,
    ).toBeUndefined();
    // The local bridge is not a turn yet: nothing is running to be stopped.
    expect(
      selectComposerAckPresentation({
        isCorner: false,
        pendingAckSentAt: NOW,
        now: NOW,
        viewerPubkey: asker,
      }),
    ).toEqual({ label: 'sending…' });
  });

  it('marks only the exact server-accepted active turn as having received a steer', () => {
    const base = {
      isCorner: true,
      activeTurnPubkey: 'agent-1',
      activeTurnAgentPubkey: 'agent-1',
      activeTurnRequestId: 'turn-1',
      activeTurnStartedAt: NOW / 1_000,
      now: NOW,
    } as const;

    expect(
      selectComposerAckPresentation({
        ...base,
        receivedSteer: { agentPubkey: 'agent-1', turnRequestId: 'turn-1' },
      })?.received,
    ).toBe(true);
    expect(
      selectComposerAckPresentation({
        ...base,
        receivedSteer: { agentPubkey: 'agent-1', turnRequestId: 'older-turn' },
      })?.received,
    ).toBeUndefined();
    expect(
      selectComposerAckPresentation({
        ...base,
        receivedSteer: { agentPubkey: 'other-agent', turnRequestId: 'turn-1' },
      })?.received,
    ).toBeUndefined();
  });

  it('names the requester test once, for the phone and the server to agree on', () => {
    expect(viewerMayStopTurn('aa', 'aa')).toBe(true);
    expect(viewerMayStopTurn('aa', 'bb')).toBe(false);
    expect(viewerMayStopTurn('aa', 'bb', 'owner')).toBe(true);
    expect(viewerMayStopTurn('aa', 'bb', 'admin')).toBe(true);
    expect(viewerMayStopTurn('aa', 'bb', 'member')).toBe(false);
    expect(viewerMayStopTurn(undefined, 'bb', 'owner')).toBe(false);
    expect(viewerMayStopTurn(undefined, 'aa')).toBe(false);
    expect(viewerMayStopTurn('aa', undefined)).toBe(false);
    expect(viewerMayStopTurn(undefined, undefined)).toBe(false);
  });

  it('recognizes a terminal receipt for the sent message after the agent has replied', () => {
    const turns: readonly RoomViewAgentTurn[] = [
      {
        requestId: 'sent-message',
        agentPubkey: 'agent-1',
        status: 'complete',
        createdAt: NOW / 1_000,
      },
    ];

    expect(hasComposerAckReceipt('sent-message', turns)).toBe(true);
  });

  it('lets a FAILED receipt clear the local sending… bridge like any terminal receipt', () => {
    // The server inscribes the failure as a Room system line; the bridge must
    // not outlive it, or the requester sees "sending…" over "could not answer".
    const turns: readonly RoomViewAgentTurn[] = [
      {
        requestId: 'sent-message',
        agentPubkey: 'agent-1',
        status: 'failed',
        createdAt: NOW / 1_000,
      },
    ];

    expect(hasComposerAckReceipt('sent-message', turns)).toBe(true);
  });

  it('does not let an older receipt clear a newer pending acknowledgement', () => {
    const turns: readonly RoomViewAgentTurn[] = [
      {
        requestId: 'older-message',
        agentPubkey: 'agent-1',
        status: 'complete',
        createdAt: NOW / 1_000,
      },
    ];

    expect(hasComposerAckReceipt('newer-message', turns)).toBe(false);
  });

  it('a claimed turn reads as working even when Room presence reads all-offline', () => {
    // The bug this pins: a helper mid-turn whose lease heartbeats lapsed read
    // as Room-offline, and the composer hid the WORKING receipt written at
    // the claim — the phone sat silent from the 15s ack bound until the
    // reply. The claim receipt is the better evidence; presence never vetoes
    // it (C77).
    expect(
      selectComposerAckState({
        isCorner: false,
        pendingAckSentAt: NOW,
        activeTurnPubkey: 'agent-1',
        now: NOW,
      }),
    ).toEqual({ kind: 'thinking', agentPubkey: 'agent-1' });
  });

  it('buzzing alone still never implies an agent is thinking', () => {
    expect(
      selectComposerAckState({
        isCorner: false,
        pendingAckSentAt: NOW,
        now: NOW,
      }),
    ).toEqual({ kind: 'buzzing' });
  });
});
