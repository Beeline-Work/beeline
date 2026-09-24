import { describe, expect, it } from 'vitest';
import type { CornerListItem } from '@beeline/buzz-client';
import {
  archivedCornersByClosure,
  archivedCornersLabel,
  cornerClosedStamp,
} from './archived-corners';

const NOW_MS = 1_000_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;

function closed(id: string, closedAt: number | undefined): CornerListItem {
  return {
    corner: { id, name: id, archived: true, createdAt: 1, updatedAt: 2 },
    lifecycle: { lifecycle: 'done', checks: 'unknown' },
    state: 'archived',
    ...(closedAt === undefined ? {} : { closedAt }),
  } as CornerListItem;
}

describe('archivedCornersByClosure', () => {
  it('orders by closure recency rather than by the order it was handed', () => {
    const order = archivedCornersByClosure([
      closed('middle', NOW_SECONDS - 86_400),
      closed('newest', NOW_SECONDS - 60),
      closed('oldest', NOW_SECONDS - 400 * 86_400),
    ]).map((item) => item.corner.id);
    expect(order).toEqual(['newest', 'middle', 'oldest']);
  });

  it('sorts a corner with no readable closure last instead of to the top', () => {
    const order = archivedCornersByClosure([
      closed('unknown', undefined),
      closed('dated', NOW_SECONDS - 86_400),
    ]).map((item) => item.corner.id);
    expect(order).toEqual(['dated', 'unknown']);
  });

  it('leaves the list it was given alone', () => {
    const input = [closed('a', NOW_SECONDS - 10), closed('b', NOW_SECONDS - 20)];
    archivedCornersByClosure([...input].reverse());
    expect(input.map((item) => item.corner.id)).toEqual(['a', 'b']);
  });
});

describe('cornerClosedStamp', () => {
  it.each([
    [10, 'closed just now'],
    [5 * 60, 'closed 5m ago'],
    [3 * 60 * 60, 'closed 3h ago'],
    [2 * 86_400, 'closed 2d ago'],
    [3 * 7 * 86_400, 'closed 3w ago'],
  ])('stamps work closed %s seconds ago as %s', (ago, expected) => {
    expect(cornerClosedStamp(NOW_SECONDS - ago, NOW_MS)).toBe(expected);
  });

  it('prints nothing rather than dating an unknown closure from the epoch', () => {
    expect(cornerClosedStamp(undefined, NOW_MS)).toBe('');
    expect(cornerClosedStamp(0, NOW_MS)).toBe('');
  });
});

describe('archivedCornersLabel', () => {
  it('names each state the footer can be read in', () => {
    expect(archivedCornersLabel({ status: 'idle' })).toBe('Archived corners');
    expect(archivedCornersLabel({ status: 'loading' })).toBe('Loading archived corners…');
    expect(archivedCornersLabel({ status: 'ready', corners: [] })).toBe('No archived corners');
    expect(
      archivedCornersLabel({ status: 'ready', corners: [closed('a', 1), closed('b', 2)] }),
    ).toBe('Archived corners · 2');
    expect(
      archivedCornersLabel({ status: 'ready', corners: [closed('a', 1)], next: '1,a' }),
    ).toBe('Archived corners · 1+');
    expect(archivedCornersLabel({ status: 'error', reason: 'Beeline is offline' })).toBe(
      'Beeline is offline. Tap to retry',
    );
  });
});
