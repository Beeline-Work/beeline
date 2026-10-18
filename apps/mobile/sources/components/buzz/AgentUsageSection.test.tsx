import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (factory: any) => factory({ buzz: { space: {}, type: {} } }), hairlineWidth: 1 },
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('./RoomListSectionHeader', () => ({ RoomListSectionHeader: 'RoomListSectionHeader' }));

import { usageCell } from './AgentUsageSection';

const now = Date.now() / 1000;
const win = (t: string, u: number, status: 'allowed' | 'rejected' = 'allowed') => ({
  rateLimitType: t, status, utilization: u, resetsAt: now + 3600, updatedAt: now,
});

describe('Usage cell (mock r7)', () => {
  it('puts each Claude window in one column with its reset, and context on the bottom line', () => {
    const cell = usageCell({
      updatedAt: now,
      windows: [win('five_hour', 0.42), win('seven_day', 0.83), win('seven_day_opus', 0.18)],
      context: { used: 612_000, size: 1_000_000 },
    }, 'claude', now);
    expect(cell.columns.map((c) => [c.label, c.value, c.tone])).toEqual([
      ['5-hour', '42%', undefined],
      ['Weekly', '83%', 'warning'],
      ['Opus weekly', '18%', undefined],
    ]);
    expect(cell.columns[0]!.foot).toMatch(/^↻ /);
    expect(cell.note).toMatch(/^Context 612K of 1M · Claude Code · updated /);
    expect(cell.old).toBe(false);
  });

  it('turns brass at exactly 80% and red when the provider stops the agent', () => {
    expect(usageCell({ updatedAt: now, windows: [win('five_hour', 0.79)] }, 'claude', now).columns[0]!.tone).toBeUndefined();
    expect(usageCell({ updatedAt: now, windows: [win('five_hour', 0.8)] }, 'claude', now).columns[0]!.tone).toBe('warning');
    const stopped = usageCell({ updatedAt: now, windows: [win('five_hour', 1, 'rejected')] }, 'claude', now).columns[0]!;
    expect(stopped).toMatchObject({ value: 'Limit', fill: 1, tone: 'danger' });
    expect(stopped.foot).toMatch(/^back /);
  });

  it('marks data older than 30 minutes and keeps the numbers', () => {
    const fresh = usageCell({ updatedAt: now - 1799, windows: [win('five_hour', 0.42)] }, 'claude', now);
    const old = usageCell({ updatedAt: now - 1800, windows: [win('five_hour', 0.42)] }, 'claude', now);
    expect(fresh.old).toBe(false);
    expect(old.old).toBe(true);
    expect(old.note).toMatch(/last updated .* · agent idle since$/);
    expect(old.columns[0]!.value).toBe('42%');
  });

  it('shows the free allowance in tokens only, shared, with a paused state', () => {
    const free = usageCell({ updatedAt: 0, windows: [], free: { used: 840_000, limit: 1_000_000, resetsAt: now + 3600 } }, 'pi', now);
    expect(free.columns).toEqual([expect.objectContaining({ label: 'Today', value: '840K of 1M', tone: 'warning' })]);
    expect(free.note).toBe('Shared by your free agents · counted by Beeline');
    expect(free.old).toBe(false);
    const paused = usageCell({ updatedAt: now, windows: [], free: { used: 1, limit: 1_000_000, resetsAt: now + 3600, paused: true } }, 'pi', now);
    expect(paused.columns[0]).toMatchObject({ value: 'Paused', tone: 'danger' });
    expect(JSON.stringify([free, paused])).not.toContain('$');
  });

  it('shows OpenRouter key spend, the key limit left, and the limit reached', () => {
    const open = usageCell({ updatedAt: now, windows: [], spend: { today: 4.12, week: 18.4 } }, 'pi', now);
    expect(open.columns.map((c) => [c.label, c.value, c.fill])).toEqual([
      ['Today', '$4.12', undefined],
      ['This week', '$18.40', undefined],
    ]);
    expect(open.note).toContain('OpenRouter key, shared');
    const near = usageCell({ updatedAt: now, windows: [], spend: { today: 9.75, week: 16.4, limit: 20, remaining: 3.6 } }, 'pi', now);
    expect(near.columns[2]).toMatchObject({ label: 'Key limit', value: '$3.60 left', foot: 'of $20', tone: 'warning' });
    const reached = usageCell({ updatedAt: now, windows: [], spend: { today: 11.2, week: 20, limit: 20, remaining: 0, rejected: true } }, 'pi', now);
    expect(reached.columns[2]).toMatchObject({ value: 'Reached', tone: 'danger' });
    // A 402 before any key figures were read still shows the stop.
    const refused = usageCell({ updatedAt: now, windows: [], spend: { rejected: true } }, 'pi', now);
    expect(refused.columns).toEqual([{ label: 'Key limit', value: 'Reached', fill: 1, tone: 'danger' }]);
  });

  it('says plainly when the harness reports nothing', () => {
    expect(usageCell({ updatedAt: now, windows: [], context: { used: 88_000, size: 200_000 } }, 'pi', now)).toEqual({
      columns: [],
      note: "Pi doesn't report usage to Beeline · Context 88K of 200K",
      old: false,
    });
  });
});
