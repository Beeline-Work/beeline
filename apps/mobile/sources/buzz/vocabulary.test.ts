import { describe, expect, it } from 'vitest';

import { formatRoomCornerCount } from './vocabulary';

describe('formatRoomCornerCount', () => {
  it('reports the singular for exactly one open corner', () => {
    expect(formatRoomCornerCount(1)).toBe('1 corner');
  });

  it('reports the plural for more than one open corner', () => {
    expect(formatRoomCornerCount(3)).toBe('3 corners');
  });

  it('reports nothing when there is no count to show', () => {
    // A Room whose corners are all terminal (merged/closed/archived) must show
    // no corner count at all, matching the server's already-filtered count.
    expect(formatRoomCornerCount(0)).toBeNull();
  });

  it('never reports a negative count', () => {
    expect(formatRoomCornerCount(-1)).toBeNull();
  });
});
