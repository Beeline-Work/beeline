import { describe, expect, it } from 'vitest';
import { CORNER_ACTIVITY_FRESHNESS_MS, type CornerMachineState } from '@beeline/buzz-client';
import type { CornerStatus, CornerSummary } from './corners';
import {
  isPinnedCornerLive,
  isPinnedCornerReadyForReview,
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

  it('pins only a fresh canonical working lease as live', () => {
    expect(
      selectPinnedCorner({ lifecycle: [corner('fresh', 'working', 'live')], now: NOW }),
    ).toEqual({ cornerId: 'fresh', status: 'live' });
    expect(
      selectPinnedCorner({
        lifecycle: [
          corner('stale', 'working', 'live', (NOW - CORNER_ACTIVITY_FRESHNESS_MS - 1) / 1_000),
        ],
        now: NOW,
      }),
    ).toBeNull();
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
  });

  it('labels only review-ready as ready for review', () => {
    expect(isPinnedCornerReadyForReview('open')).toBe(true);
    expect(isPinnedCornerReadyForReview('live')).toBe(false);
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

  it('prefers the visibly streaming lane and preserves the Room offline guard', () => {
    expect(
      selectTurnProgressAgentPubkey({
        isCorner: true,
        agentsOffline: false,
        liveTurnPubkey: 'streaming-agent',
        activeTurnPubkey: 'receipt-agent',
      }),
    ).toBe('streaming-agent');
    expect(
      selectTurnProgressAgentPubkey({
        isCorner: false,
        agentsOffline: true,
        liveTurnPubkey: 'room-agent',
      }),
    ).toBeNull();
  });

  it('stays dark when neither a live lane nor a working receipt exists', () => {
    expect(selectTurnProgressAgentPubkey({ isCorner: true, agentsOffline: false })).toBeNull();
  });
});
