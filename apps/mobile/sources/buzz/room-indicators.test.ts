import { describe, expect, it } from 'vitest';
import type { CornerStatus, CornerSummary } from './corners';
import {
  isPinnedCornerLive,
  isPinnedCornerReadyForReview,
  selectPinnedCorner,
} from './room-indicators';

const corner = (id: string, status: CornerStatus, at = 100): CornerSummary => ({
  id,
  name: id,
  openerPubkey: 'agent',
  status,
  createdAt: at,
  lastActivityAt: at,
});

const base = {
  signals: [] as { subchannelId: string; status: CornerStatus; timestamp: number }[],
  lifecycle: [] as CornerSummary[],
  lifecycleLoaded: true,
};

describe('selectPinnedCorner', () => {
  it('pins nothing for a Room whose corners have all closed', () => {
    expect(
      selectPinnedCorner({
        ...base,
        signals: [{ subchannelId: 'honeybees', status: 'archived', timestamp: 100 }],
        lifecycle: [corner('honeybees', 'archived')],
      }),
    ).toBeNull();
  });

  it('never pins an immutably terminal merged or archived corner', () => {
    for (const status of ['merged', 'archived'] as const) {
      expect(selectPinnedCorner({ ...base, lifecycle: [corner('done', status)] })).toBeNull();
    }
  });

  it('pins an open-but-idle corner and a needs-attention corner too, not just a working one', () => {
    // The line means "open and worth returning to," not "doing work right
    // now" — that over-correction is exactly the bug this widens back out of.
    for (const status of ['open', 'needs-attention'] as const) {
      expect(selectPinnedCorner({ ...base, lifecycle: [corner('idle', status)] })).toEqual({
        cornerId: 'idle',
        status,
      });
    }
  });

  it('pins an open corner and reports its status', () => {
    expect(
      selectPinnedCorner({
        ...base,
        signals: [{ subchannelId: 'feat', status: 'live', timestamp: 10 }],
      }),
    ).toEqual({ cornerId: 'feat', status: 'live' });
  });

  it('lets the more terminal source win, so a stale snapshot cannot re-open a closed corner', () => {
    // The lifecycle list was fetched while the corner was still running; the
    // Room transcript has since carried its archive notice.
    expect(
      selectPinnedCorner({
        ...base,
        lifecycle: [corner('honeybees', 'live')],
        signals: [{ subchannelId: 'honeybees', status: 'archived', timestamp: 500 }],
      }),
    ).toBeNull();
    // ...and the other way round: a stale live *card* against a closed snapshot.
    expect(
      selectPinnedCorner({
        ...base,
        lifecycle: [corner('honeybees', 'archived')],
        signals: [{ subchannelId: 'honeybees', status: 'live', timestamp: 500 }],
      }),
    ).toBeNull();
  });

  it('drops a stale "ready for review" pin once the corner is closed without ever landing', () => {
    // The captain's repro: a corner whose session died sat on `open` (READY)
    // forever, because nothing ever published its close. Once the daemon does
    // — see `pollAbandonedCornerCloses` in `apps/body/src/body.ts` — the
    // review-ready pin has to go, not merely lose the tie-break to another
    // corner.
    expect(
      selectPinnedCorner({
        ...base,
        lifecycle: [corner('honeybees', 'open')],
        signals: [{ subchannelId: 'honeybees', status: 'archived', timestamp: 900 }],
      }),
    ).toBeNull();
  });

  it('prefers a review-ready corner over one still working, then the most recent', () => {
    // Review-ready is the most actionable state a captain can act on, so it
    // wins the single pin even over a corner that is older but still running.
    expect(
      selectPinnedCorner({
        ...base,
        lifecycle: [corner('waiting', 'open', 10), corner('running', 'live', 900)],
      }),
    ).toEqual({ cornerId: 'waiting', status: 'open' });
    expect(
      selectPinnedCorner({
        ...base,
        lifecycle: [corner('older', 'live', 100), corner('newer', 'live', 900)],
      }),
    ).toEqual({ cornerId: 'newer', status: 'live' });
  });

  it('ranks review-ready above working above needs-attention, recency breaks ties within a tier', () => {
    expect(
      selectPinnedCorner({
        ...base,
        lifecycle: [
          corner('attn', 'needs-attention', 900),
          corner('working', 'live', 500),
          corner('ready', 'open', 10),
        ],
      }),
    ).toEqual({ cornerId: 'ready', status: 'open' });
    expect(
      selectPinnedCorner({
        ...base,
        lifecycle: [corner('older-ready', 'open', 10), corner('newer-ready', 'open', 900)],
      }),
    ).toEqual({ cornerId: 'newer-ready', status: 'open' });
  });

  it('pins a just-permitted corner nobody has a status for yet', () => {
    expect(
      selectPinnedCorner({
        ...base,
        permittedCorner: { cornerId: 'brand-new', timestamp: Date.now() },
      }),
    ).toEqual({ cornerId: 'brand-new', status: 'live' });
  });

  it('never pins a permitted corner that has since been archived', () => {
    // The ALLOW event stays in the transcript forever; the corner it opened
    // does not. This is the exact shape of the shipped bug.
    expect(
      selectPinnedCorner({
        ...base,
        permittedCorner: { cornerId: 'honeybees', timestamp: Date.now() },
        lifecycle: [corner('honeybees', 'archived')],
      }),
    ).toBeNull();
    expect(
      selectPinnedCorner({
        ...base,
        permittedCorner: { cornerId: 'honeybees', timestamp: Date.now() },
        signals: [{ subchannelId: 'honeybees', status: 'archived', timestamp: 5 }],
      }),
    ).toBeNull();
  });

  it('holds a permitted corner back until the lifecycle list has answered', () => {
    // Before the read lands, "unknown corner" cannot be told from "archived
    // corner", so the line stays dark rather than guessing.
    expect(
      selectPinnedCorner({
        ...base,
        lifecycleLoaded: false,
        permittedCorner: { cornerId: 'brand-new', timestamp: Date.now() },
      }),
    ).toBeNull();
  });

  it('reads only the latest status per corner, not its history', () => {
    expect(
      selectPinnedCorner({
        ...base,
        signals: [
          { subchannelId: 'a', status: 'live', timestamp: 1 },
          { subchannelId: 'a', status: 'failed', timestamp: 50 },
          { subchannelId: 'b', status: 'live', timestamp: 10 },
        ],
      }),
    ).toEqual({ cornerId: 'b', status: 'live' });
  });

  it('pins nothing for a Room with no corners at all, however busy its agent is', () => {
    // There is no turn input to this function — that is the point.
    expect(selectPinnedCorner({ ...base })).toBeNull();
  });
});

describe('isPinnedCornerLive', () => {
  it('spends gold only on a corner that is actually running', () => {
    expect(isPinnedCornerLive('live')).toBe(true);
    expect(isPinnedCornerLive('needs-attention')).toBe(false);
    expect(isPinnedCornerLive('open')).toBe(false);
  });
});

describe('isPinnedCornerReadyForReview', () => {
  it('is true only for the review-ready status', () => {
    expect(isPinnedCornerReadyForReview('open')).toBe(true);
    expect(isPinnedCornerReadyForReview('live')).toBe(false);
    expect(isPinnedCornerReadyForReview('needs-attention')).toBe(false);
  });
});
