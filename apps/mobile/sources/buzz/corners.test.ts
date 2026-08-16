import { describe, expect, it } from 'vitest';
import {
  cornerName,
  cornerStatusPresentation,
  isCornerActive,
  mapRawCornerStatusTag,
  resolveCornerLifecycleStatus,
  selectMostRecentActiveCornerId,
  sortCorners,
  type CornerSummary,
} from './corners';

describe('corner navigation model', () => {
  const corners: CornerSummary[] = [
    { id: 'archived', name: 'old', openerPubkey: 'a', status: 'archived', createdAt: 4 },
    { id: 'open', name: 'ready', openerPubkey: 'a', status: 'open', createdAt: 2 },
    { id: 'live-new', name: 'new', openerPubkey: 'a', status: 'live', createdAt: 3 },
    { id: 'live-old', name: 'older', openerPubkey: 'a', status: 'live', createdAt: 1 },
    { id: 'stuck', name: 'stuck', openerPubkey: 'a', status: 'needs-attention', createdAt: 5 },
    { id: 'broken', name: 'broken', openerPubkey: 'a', status: 'failed', createdAt: 6 },
  ];

  it('keeps active corners first in the room-scoped corner list', () => {
    expect(sortCorners(corners).map((corner) => corner.id)).toEqual([
      'live-new',
      'live-old',
      'stuck',
      'open',
      'broken',
      'archived',
    ]);
  });

  it('breaks ties by most recent activity, not just creation time', () => {
    const stale: CornerSummary = {
      id: 'stale',
      name: 'stale',
      openerPubkey: 'a',
      status: 'live',
      createdAt: 100,
      lastActivityAt: 1,
    };
    const busy: CornerSummary = {
      id: 'busy',
      name: 'busy',
      openerPubkey: 'a',
      status: 'live',
      createdAt: 1,
      lastActivityAt: 100,
    };
    expect(sortCorners([stale, busy]).map((corner) => corner.id)).toEqual(['busy', 'stale']);
  });

  it('never exposes legacy subchannel names in person-facing navigation', () => {
    expect(cornerName('sub-room-id', '12345678-abcd')).toBe('corner-12345678');
    expect(cornerName('  #Auth callback  ', 'unused')).toBe('Auth-callback');
  });

  it('uses redundant monochrome glyph and text for every status', () => {
    expect(cornerStatusPresentation('live')).toEqual({ glyph: '◆', label: 'LIVE' });
    expect(cornerStatusPresentation('needs-attention')).toEqual({
      glyph: '▲',
      label: 'NEEDS ATTENTION',
    });
    expect(cornerStatusPresentation('open')).toEqual({ glyph: '◇', label: 'OPEN' });
    expect(cornerStatusPresentation('failed')).toEqual({ glyph: '✕', label: 'FAILED' });
    expect(cornerStatusPresentation('merged')).toEqual({ glyph: '✓', label: 'MERGED' });
    expect(cornerStatusPresentation('archived')).toEqual({ glyph: '□', label: 'ARCHIVED' });
  });

  it('collapses every raw wire status onto the one canonical model', () => {
    // body.ts always emits BOTH `status` (wire, "starting" collapsed to "open")
    // and `display-status` (exact). Both must land on the same canonical value.
    expect(mapRawCornerStatusTag('starting')).toBe('live');
    expect(mapRawCornerStatusTag('working')).toBe('live');
    expect(mapRawCornerStatusTag('open')).toBe('live');
    expect(mapRawCornerStatusTag('live')).toBe('live');
    expect(mapRawCornerStatusTag('needs-attention')).toBe('needs-attention');
    expect(mapRawCornerStatusTag('ready')).toBe('open');
    expect(mapRawCornerStatusTag('failed')).toBe('failed');
    expect(mapRawCornerStatusTag('merged')).toBe('merged');
    expect(mapRawCornerStatusTag('archived')).toBe('archived');
    expect(mapRawCornerStatusTag(undefined)).toBeUndefined();
    expect(mapRawCornerStatusTag('nonsense')).toBeUndefined();
  });

  it('treats only live/needs-attention as actively worked', () => {
    expect(isCornerActive('live')).toBe(true);
    expect(isCornerActive('needs-attention')).toBe(true);
    expect(isCornerActive('open')).toBe(false);
    expect(isCornerActive('failed')).toBe(false);
    expect(isCornerActive('merged')).toBe(false);
    expect(isCornerActive('archived')).toBe(false);
  });

  describe('selectMostRecentActiveCornerId', () => {
    it('picks the most recently active corner over a stale one', () => {
      const id = selectMostRecentActiveCornerId([
        { subchannelId: 'stale', status: 'live', timestamp: 1 },
        { subchannelId: 'fresh', status: 'live', timestamp: 100 },
      ]);
      expect(id).toBe('fresh');
    });

    it('prefers an actively-worked corner over a merely more recent terminal one', () => {
      const id = selectMostRecentActiveCornerId([
        { subchannelId: 'working', status: 'live', timestamp: 1 },
        { subchannelId: 'merged', status: 'merged', timestamp: 100 },
      ]);
      expect(id).toBe('working');
    });

    it('only considers each corner\'s latest status, not every historical update', () => {
      const id = selectMostRecentActiveCornerId([
        { subchannelId: 'a', status: 'live', timestamp: 1 },
        { subchannelId: 'a', status: 'failed', timestamp: 50 },
        { subchannelId: 'b', status: 'live', timestamp: 10 },
      ]);
      // 'a' is now failed (inactive), so the only active candidate is 'b'.
      expect(id).toBe('b');
    });

    it('falls back to the most recent overall when nothing is active', () => {
      const id = selectMostRecentActiveCornerId([
        { subchannelId: 'a', status: 'merged', timestamp: 1 },
        { subchannelId: 'b', status: 'archived', timestamp: 50 },
      ]);
      expect(id).toBe('b');
    });

    it('returns undefined for no corners', () => {
      expect(selectMostRecentActiveCornerId([])).toBeUndefined();
    });
  });

  describe('resolveCornerLifecycleStatus', () => {
    it('keeps the last known status while archival is unconfirmed', () => {
      expect(resolveCornerLifecycleStatus('live', false)).toBe('live');
      expect(resolveCornerLifecycleStatus(null, false)).toBeNull();
    });

    // This is the corner view badge's exact staleness bug: the badge's known
    // status is a one-time snapshot fetched at mount, but confirmed-archived
    // can resolve later (via a live signal, on an already-mounted screen).
    // The stale snapshot must never keep outranking a confirmed archive.
    it('overrides a stale non-terminal snapshot once archival is confirmed', () => {
      expect(resolveCornerLifecycleStatus('live', true)).toBe('archived');
      expect(resolveCornerLifecycleStatus('open', true)).toBe('archived');
      expect(resolveCornerLifecycleStatus('needs-attention', true)).toBe('archived');
      expect(resolveCornerLifecycleStatus('failed', true)).toBe('archived');
      expect(resolveCornerLifecycleStatus(null, true)).toBe('archived');
    });

    it('does not downgrade an already-terminal snapshot below archived precedence', () => {
      // 'merged' still yields to a confirmed archive (archived outranks merged
      // in cornerStatusPrecedence), matching the monotonic guard used elsewhere.
      expect(resolveCornerLifecycleStatus('merged', true)).toBe('archived');
      expect(resolveCornerLifecycleStatus('archived', true)).toBe('archived');
    });
  });
});
