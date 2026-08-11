import { describe, expect, it } from 'vitest';
import {
  cornerName,
  cornerStatusPresentation,
  sortCorners,
  type CornerSummary,
} from './corners';

describe('corner navigation model', () => {
  const corners: CornerSummary[] = [
    { id: 'archived', name: 'old', openerPubkey: 'a', status: 'archived', createdAt: 4 },
    { id: 'open', name: 'ready', openerPubkey: 'a', status: 'open', createdAt: 2 },
    { id: 'live-new', name: 'new', openerPubkey: 'a', status: 'live', createdAt: 3 },
    { id: 'live-old', name: 'older', openerPubkey: 'a', status: 'live', createdAt: 1 },
  ];

  it('keeps active corners first in the room-scoped corner list', () => {
    expect(sortCorners(corners).map((corner) => corner.id)).toEqual([
      'live-new',
      'live-old',
      'open',
      'archived',
    ]);
  });

  it('never exposes legacy subchannel names in person-facing navigation', () => {
    expect(cornerName('sub-room-id', '12345678-abcd')).toBe('corner-12345678');
    expect(cornerName('  #Auth callback  ', 'unused')).toBe('Auth-callback');
  });

  it('uses redundant monochrome glyph and text for every status', () => {
    expect(cornerStatusPresentation('live')).toEqual({ glyph: '◆', label: 'LIVE' });
    expect(cornerStatusPresentation('open')).toEqual({ glyph: '◇', label: 'OPEN' });
    expect(cornerStatusPresentation('merged')).toEqual({ glyph: '✓', label: 'MERGED' });
    expect(cornerStatusPresentation('archived')).toEqual({ glyph: '□', label: 'ARCHIVED' });
  });
});
