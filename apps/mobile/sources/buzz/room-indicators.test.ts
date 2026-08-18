import { describe, expect, it } from 'vitest';
import type { CornerStatus, CornerSummary } from './corners';
import { isPinnedCornerLive, selectPinnedCorner } from './room-indicators';

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

  it('never pins a merged or failed corner either', () => {
    for (const status of ['merged', 'failed'] as const) {
      expect(
        selectPinnedCorner({ ...base, lifecycle: [corner('done', status)] }),
      ).toBeNull();
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

  it('prefers the corner that is actually running, then the most recent', () => {
    expect(
      selectPinnedCorner({
        ...base,
        lifecycle: [corner('waiting', 'open', 900), corner('running', 'live', 100)],
      }),
    ).toEqual({ cornerId: 'running', status: 'live' });
    expect(
      selectPinnedCorner({
        ...base,
        lifecycle: [corner('older', 'live', 100), corner('newer', 'live', 900)],
      }),
    ).toEqual({ cornerId: 'newer', status: 'live' });
  });

  it('pins a just-permitted corner nobody has a status for yet', () => {
    expect(
      selectPinnedCorner({ ...base, permittedCornerId: 'brand-new' }),
    ).toEqual({ cornerId: 'brand-new', status: 'live' });
  });

  it('never pins a permitted corner that has since been archived', () => {
    // The ALLOW event stays in the transcript forever; the corner it opened
    // does not. This is the exact shape of the shipped bug.
    expect(
      selectPinnedCorner({
        ...base,
        permittedCornerId: 'honeybees',
        lifecycle: [corner('honeybees', 'archived')],
      }),
    ).toBeNull();
    expect(
      selectPinnedCorner({
        ...base,
        permittedCornerId: 'honeybees',
        signals: [{ subchannelId: 'honeybees', status: 'archived', timestamp: 5 }],
      }),
    ).toBeNull();
  });

  it('holds a permitted corner back until the lifecycle list has answered', () => {
    // Before the read lands, "unknown corner" cannot be told from "archived
    // corner", so the line stays dark rather than guessing.
    expect(
      selectPinnedCorner({ ...base, lifecycleLoaded: false, permittedCornerId: 'brand-new' }),
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
