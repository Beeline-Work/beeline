import { describe, expect, it } from 'vitest';
import {
  CORNER_ACTIVITY_FRESHNESS_MS,
  type RoomViewAgentTurn,
} from '@beeline/buzz-client';
import type { CornerMachineState, CornerStatus, CornerSummary } from './corners';
import {
  COMPOSER_ACK_BOUND_MS,
  hasComposerAckReceipt,
  isPinnedCornerLive,
  isPinnedCornerReadyForReview,
  pinnedCornerVerb,
  selectComposerAckState,
  selectPinnedCorner,
  selectTurnProgressAgentPubkey,
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
    expect(
      selectPinnedCorner({ lifecycle: [corner('opening', 'open', null)], now: NOW }),
    ).toEqual({ cornerId: 'opening', status: 'preparing' });
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

  it('4. dead live bar uses the indexed receipt state without a screen-owned freshness clock', () => {
    expect(
      selectPinnedCorner({ lifecycle: [corner('fresh', 'working', 'live')], now: NOW }),
    ).toEqual({ cornerId: 'fresh', status: 'live' });
    expect(
      selectPinnedCorner({
        lifecycle: [
          corner('older-receipt', 'working', 'live', 1),
        ],
        now: NOW,
      }),
    ).toEqual({ cornerId: 'older-receipt', status: 'live' });
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

  it('reports delivery-unclear once the bound elapses with no receipt', () => {
    expect(
      selectComposerAckState({
        isCorner: false,
        agentsOffline: false,
        pendingAckSentAt: NOW,
        now: NOW + COMPOSER_ACK_BOUND_MS,
      }),
    ).toEqual({ kind: 'delivery-unclear' });
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
