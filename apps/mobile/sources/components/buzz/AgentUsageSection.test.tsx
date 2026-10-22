import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('./IndexRow', () => ({ InlineRow: 'InlineRow' }));
vi.mock('./Button', () => ({ Button: 'Button' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (factory: any) => factory({ buzz: { space: {}, type: {} } }), hairlineWidth: 1 },
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('./RoomListSectionHeader', () => ({ RoomListSectionHeader: 'RoomListSectionHeader' }));

import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { AgentUsageSection, usageCell } from './AgentUsageSection';

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
    expect(cell.columns.every((c) => !c.foot)).toBe(true);
    expect(cell.stamp).toMatch(/^resets .* · updated /);
    expect(cell.note).toMatch(/^Context 612K of 1M · Claude Code$/);
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
    expect(old.stamp).toMatch(/^updated .* · agent idle since then$/);
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

  it('shows a quota-axi plan read: provider windows, credits left and the plan', () => {
    const codex = usageCell({
      updatedAt: now,
      windows: [{ ...win('weekly', 0.47), label: 'week' }],
      plan: 'pro',
      credits: { remaining: 62174.92 },
      context: { used: 82_372, size: 475_000 },
    }, 'codex', now);
    expect(codex.columns.map((c) => [c.label, c.value])).toEqual([
      ['Weekly', '47%'],
      ['Credits', '62,174 left'],
    ]);
    expect(codex.note).toMatch(/^Context 82K of 475K · Codex · pro plan$/);
    const cursor = usageCell({
      updatedAt: now,
      windows: [{ ...win('included_usage', 0.12), label: 'included usage' }, { ...win('grok_bot', 0), label: 'Grok Bot' }],
      plan: 'Ultra',
    }, 'cursor', now);
    expect(cursor.columns.map((c) => c.label)).toEqual(['Included', 'Grok Bot']);
    expect(cursor.note).toMatch(/^Cursor · Ultra plan$/);
  });

  it('Reproduction R2: keeps the section for a harness that never reported usage', () => {
    for (const [harness, name] of [['codex', 'Codex'], ['cursor', 'Cursor']]) {
      let renderer: any;
      act(() => {
        renderer = create(<AgentUsageSection harness={harness} />);
      });
      expect(renderer.root.findByProps({ testID: 'agent-usage' })).toBeDefined();
      expect(renderer.root.findByProps({ testID: 'agent-usage-note' }).props.children).toBe(
        `${name} doesn't report usage to Beeline`,
      );
    }
  });
});


describe('approved Usage gallery and refresh', () => {
  afterEach(() => vi.useRealTimers());
  it('groups the most common reset and leaves the distinct Cursor meter below its bar', () => {
    const usage = { updatedAt: now, windows: [win('included_usage', .04), win('auto_usage', .05), win('api_usage', 0), { ...win('grok_bot', 0), resetsAt: now + 7200 }] };
    const cell = usageCell(usage, 'cursor', now);
    expect(cell.columns.slice(0, 3).map((c) => c.foot)).toEqual([undefined, undefined, undefined]);
    expect(cell.columns[3]!.foot).toMatch(/^resets /);
    expect(cell.stamp).toMatch(/^resets .* · updated /);
  });
  it('keeps Claude session reset separate from its shared weekly reset', () => {
    const cell = usageCell({ updatedAt: now, windows: [{ ...win('five_hour', .37), resetsAt: now + 100 }, win('seven_day', .12), win('seven_day_opus', .03)] }, 'claude', now);
    expect(cell.columns[0]!.foot).toMatch(/^resets /);
    expect(cell.columns.slice(1).every((c) => !c.foot)).toBe(true);
  });
  it('keeps both Codex reset lines when no reset is shared', () => {
    const cell = usageCell({ updatedAt: now, windows: [win('five_hour', .12), { ...win('weekly', .04), resetsAt: now + 7200 }] }, 'codex', now);
    expect(cell.columns.every((c) => c.foot?.startsWith('resets '))).toBe(true);
    expect(cell.stamp).toMatch(/^updated /);
    expect(cell.stamp).not.toContain('resets');
  });
  it('sends once, disables until a committed timestamp changes, and ignores a late failure', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const onRefresh = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    let renderer: any;
    const usage = { updatedAt: now, windows: [win('weekly', .1)] };
    act(() => { renderer = create(<AgentUsageSection usage={usage} onRefresh={onRefresh} />); });
    const button = () => renderer.root.findByType('Button');
    await act(async () => { button().props.onPress(); button().props.onPress(); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(button().props.disabled).toBe(true);
    act(() => renderer.update(<AgentUsageSection usage={{ ...usage, updatedAt: now + 1 }} onRefresh={onRefresh} />));
    expect(button().props.disabled).toBe(false);
    await act(async () => reject(new Error('late')));
    expect(renderer.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
    act(() => renderer.unmount());
  });
  it('shows failure on request rejection or timeout and permits retry', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    let renderer: any;
    act(() => { renderer = create(<AgentUsageSection usage={{ updatedAt: now, windows: [win('weekly', .1)] }} onRefresh={onRefresh} />); });
    const button = () => renderer.root.findByType('Button');
    await act(async () => button().props.onPress());
    expect(renderer.root.findByProps({ accessibilityRole: 'alert' }).props.children).toBe("Couldn't refresh");
    await act(async () => button().props.onPress());
    expect(renderer.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
    act(() => vi.advanceTimersByTime(15_000));
    expect(button().props.disabled).toBe(false);
    expect(renderer.root.findByProps({ accessibilityRole: 'alert' }).props.children).toBe("Couldn't refresh");
    expect(onRefresh).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });
  it('omits refresh for live free allowance and absent usage', () => {
    for (const usage of [undefined, { updatedAt: now, windows: [], free: { used: 640000, limit: 3000000, resetsAt: now + 3600 } }]) {
      let renderer: any;
      act(() => { renderer = create(<AgentUsageSection usage={usage} onRefresh={async () => undefined} />); });
      expect(renderer.root.findAllByType('Button')).toHaveLength(0);
      act(() => renderer.unmount());
    }
  });
});
