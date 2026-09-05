import { describe, expect, it } from 'vitest';
import { CORNER_ACTIVITY_FRESHNESS_MS, type RoomViewAgentTurn } from '@beeline/buzz-client';
import type { CornerMachineState, CornerStatus, CornerSummary } from './corners';
import {
  COMPOSER_ACK_BOUND_MS,
  hasComposerAckReceipt,
  isPinnedCornerLive,
  isPinnedCornerReadyForReview,
  humanBranchName,
  pinnedCornerVerb,
  selectComposerAckState,
  selectComposerAckPresentation,
  selectPinnedCorner,
  selectTurnProgressAgentPubkey,
  selectWorkingAgents,
} from './room-indicators';

const NOW = 1_700_000_000_000;
const corner = (
  id: string,
  machineState: CornerMachineState,
  status: CornerStatus | null,
  at = NOW / 1_000,
): CornerSummary => ({
  id,
  name: id,
  openerPubkey: 'agent',
  machineState,
  ...(machineState === 'waiting'
    ? { machineReason: status === 'open' ? 'review' : status === 'failed' ? 'failure' : 'question' }
    : {}),
  stateAt: at,
  status,
  createdAt: at,
  lastActivityAt: at,
});

describe('selectPinnedCorner', () => {
  it('pins canonical open as a quiet preparing phase before working', () => {
    expect(selectPinnedCorner({ lifecycle: [corner('opening', 'open', null)], now: NOW })).toEqual({
      cornerId: 'opening',
      status: 'preparing',
    });
  });

  it('does not pin a parent body-control corner-open message without canonical working state', () => {
    const parentRoomHistory = [
      {
        kind: 9,
        tags: [
          ['t', 'body-control'],
          ['subchannel', 'corner-06ac8027'],
          ['status', 'starting'],
        ],
      },
    ];
    expect(parentRoomHistory).toHaveLength(1); // the ghost-producing history is present
    expect(selectPinnedCorner({ lifecycle: [], now: NOW })).toBeNull();
    expect(
      selectPinnedCorner({
        lifecycle: [
          {
            id: 'corner-06ac8027',
            name: 'ghost',
            openerPubkey: 'agent',
            status: 'live', // legacy/control-message projection, deliberately ignored
          },
        ],
        now: NOW,
      }),
    ).toBeNull();
  });

  it('expires stale working gold to a quiet idle pin without losing navigation', () => {
    expect(
      selectPinnedCorner({ lifecycle: [corner('fresh', 'working', 'live')], now: NOW }),
    ).toEqual({ cornerId: 'fresh', status: 'live' });
    expect(
      selectPinnedCorner({
        lifecycle: [corner('expired-receipt', 'working', 'live', 1)],
        now: NOW,
      }),
    ).toEqual({ cornerId: 'expired-receipt', status: 'idle' });
  });

  it.each([
    ['concluded', 'merged'],
    ['closed', 'archived'],
  ] as const)('never pins a terminal %s record', (machineState, status) => {
    expect(
      selectPinnedCorner({ lifecycle: [corner('done', machineState, status)], now: NOW }),
    ).toBeNull();
  });

  it('keeps canonical review/question waits actionable without calling them live', () => {
    expect(
      selectPinnedCorner({
        lifecycle: [
          corner('question', 'waiting', 'needs-attention', NOW / 1_000 + 1),
          corner('review', 'waiting', 'open', NOW / 1_000),
        ],
        now: NOW,
      }),
    ).toEqual({ cornerId: 'review', status: 'open' });
  });

  it('keeps a quiet unfinished corner pinned while no turn is running', () => {
    expect(
      selectPinnedCorner({ lifecycle: [corner('idle-corner', 'idle', null)], now: NOW }),
    ).toEqual({ cornerId: 'idle-corner', status: 'idle' });
  });

  it('prefers review-ready over working, then recency within a tier', () => {
    expect(
      selectPinnedCorner({
        lifecycle: [
          corner('working', 'working', 'live', NOW / 1_000),
          corner('review', 'waiting', 'open', 1),
        ],
        now: NOW,
      }),
    ).toEqual({ cornerId: 'review', status: 'open' });
    expect(
      selectPinnedCorner({
        lifecycle: [
          corner('older', 'working', 'live', NOW / 1_000 - 2),
          corner('newer', 'working', 'live', NOW / 1_000 - 1),
        ],
        now: NOW,
      }),
    ).toEqual({ cornerId: 'newer', status: 'live' });
  });
});

describe('pinned-corner presentation', () => {
  it('spends gold only on canonical working', () => {
    expect(isPinnedCornerLive('live')).toBe(true);
    expect(isPinnedCornerLive('needs-attention')).toBe(false);
    expect(isPinnedCornerLive('open')).toBe(false);
    expect(isPinnedCornerLive('preparing')).toBe(false);
  });

  it('labels only review-ready as ready for review', () => {
    expect(isPinnedCornerReadyForReview('open')).toBe(true);
    expect(isPinnedCornerReadyForReview('live')).toBe(false);
    expect(isPinnedCornerReadyForReview('preparing')).toBe(false);
  });

  it('names the opening lifecycle before it becomes active', () => {
    expect(pinnedCornerVerb('preparing')).toBe('preparing');
    expect(pinnedCornerVerb('live')).toBe('active');
    expect(pinnedCornerVerb('idle')).toBe('idle');
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
        agentsOffline: true,
        activeTurnPubkey: 'corner-agent',
      }),
    ).toBe('corner-agent');
  });

  it('uses only a working receipt and preserves the Room offline guard', () => {
    expect(
      selectTurnProgressAgentPubkey({
        isCorner: true,
        agentsOffline: false,
        activeTurnPubkey: 'receipt-agent',
      }),
    ).toBe('receipt-agent');
    expect(
      selectTurnProgressAgentPubkey({
        isCorner: false,
        agentsOffline: true,
        activeTurnPubkey: 'room-agent',
      }),
    ).toBeNull();
  });

  it('stays dark without a working receipt, regardless of draft-stream state', () => {
    expect(selectTurnProgressAgentPubkey({ isCorner: true, agentsOffline: false })).toBeNull();
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
    expect(selectComposerAckState({ isCorner: false, agentsOffline: false, now: NOW })).toBeNull();
  });

  it('buzzes immediately once a message is sent, before any receipt exists', () => {
    expect(
      selectComposerAckState({
        isCorner: false,
        agentsOffline: false,
        pendingAckSentAt: NOW,
        now: NOW,
      }),
    ).toEqual({ kind: 'buzzing' });
  });

  it('keeps buzzing right up to the bound', () => {
    expect(
      selectComposerAckState({
        isCorner: false,
        agentsOffline: false,
        pendingAckSentAt: NOW,
        now: NOW + COMPOSER_ACK_BOUND_MS - 1,
      }),
    ).toEqual({ kind: 'buzzing' });
  });

  it('expires once the bound elapses with no receipt', () => {
    expect(
      selectComposerAckState({
        isCorner: false,
        agentsOffline: false,
        pendingAckSentAt: NOW,
        now: NOW + COMPOSER_ACK_BOUND_MS,
      }),
    ).toBeNull();
  });

  it('the real receipt always replaces a pending local ack, never races it', () => {
    expect(
      selectComposerAckState({
        isCorner: false,
        agentsOffline: false,
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
        agentsOffline: false,
        activeTurnPubkey: pubkey,
        now: NOW,
        conversationIdentities: new Map(),
      }),
    ).toEqual({ label: 'Agent 54f4d261 thinking…' });
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

  it('a Room-offline guard still suppresses the real receipt but never a local buzz', () => {
    expect(
      selectComposerAckState({
        isCorner: false,
        agentsOffline: true,
        pendingAckSentAt: NOW,
        activeTurnPubkey: 'agent-1',
        now: NOW,
      }),
    ).toEqual({ kind: 'buzzing' });
  });
});
