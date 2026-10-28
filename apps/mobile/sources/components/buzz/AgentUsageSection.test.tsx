import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('./IndexRow', () => ({ InlineRow: 'InlineRow' }));
vi.mock('./Button', () => ({ Button: 'Button' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
const announce = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({
  Text: 'Text', View: 'View', ActivityIndicator: 'ActivityIndicator',
  AccessibilityInfo: { announceForAccessibility: announce },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (factory: any) => factory({ buzz: { space: {}, type: {} } }), hairlineWidth: 1 },
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('./RoomListSectionHeader', () => ({ RoomListSectionHeader: 'RoomListSectionHeader' }));

import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { AgentUsageSection, USAGE_REFRESH_CLIENT_TIMEOUT_MS, usageCell } from './AgentUsageSection';

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
    expect(cell.muted).toBe(false);
  });

  it('turns brass at exactly 80% and red when the provider stops the agent', () => {
    expect(usageCell({ updatedAt: now, windows: [win('five_hour', 0.79)] }, 'claude', now).columns[0]!.tone).toBeUndefined();
    expect(usageCell({ updatedAt: now, windows: [win('five_hour', 0.8)] }, 'claude', now).columns[0]!.tone).toBe('warning');
    const stopped = usageCell({ updatedAt: now, windows: [win('five_hour', 1, 'rejected')] }, 'claude', now).columns[0]!;
    expect(stopped).toMatchObject({ value: 'Limit', fill: 1, tone: 'danger' });
    expect(stopped.foot).toMatch(/^back /);
  });

  it('labels old numbers with when they were really read and why, never agent idle', () => {
    const at = now - 3 * 3600;
    const old = usageCell({ updatedAt: at, windows: [{ ...win('five_hour', 0.85), updatedAt: at }] }, 'claude', now);
    expect(old.muted).toBe(false);
    expect(old.stamp).not.toContain('idle');
    const reasons: Array<[Record<string, unknown>, RegExp]> = [
      [{ status: 'rate_limited', at: now, retryAfter: now + 600 }, /^updated .* · rate-limited, retrying .+$/],
      [{ status: 'signed_out', at: now }, /^updated .* · sign-in expired till next turn$/],
      [{ status: 'stale', at: now, reason: 'fetch failed' }, /^updated .* · couldn't read: fetch failed$/],
      [{ status: 'failed', at: now, reason: 'unavailable' }, /^updated .* · couldn't read: unavailable$/],
    ];
    for (const [read, line] of reasons) {
      const cell = usageCell({ updatedAt: at, windows: [{ ...win('five_hour', 0.85), updatedAt: at }], read: read as any }, 'claude', now);
      expect(cell.muted).toBe(true);
      expect(cell.stamp).toMatch(line);
      // Muted numbers keep their value and bar but lose the brass near-limit mark.
      expect(cell.columns[0]).toMatchObject({ value: '85%', fill: 0.85, tone: undefined });
    }
    const offline = usageCell({ updatedAt: at, windows: [win('five_hour', 1, 'rejected')], machine: 'squire' }, 'claude', now, { status: 'offline' });
    expect(offline.stamp).toMatch(/^updated .* · squire is offline$/);
    // Red stays for a limit that is actually reached.
    expect(offline.columns[0]!.tone).toBe('danger');
  });

  it('names the other agents that share the plan account', () => {
    const cell = usageCell({ updatedAt: now, windows: [win('five_hour', 0.14)], plan: 'max', sharedWith: ['Jellybean', 'Nerd'] }, 'claude', now);
    expect(cell.note).toBe('Claude Code · max plan');
    expect(cell.shared).toBe('Shared with Jellybean and Nerd');
  });

  it('shows the free allowance in tokens only, shared, with a paused state', () => {
    const free = usageCell({ updatedAt: 0, windows: [], free: { used: 840_000, limit: 1_000_000, resetsAt: now + 3600 } }, 'pi', now);
    expect(free.columns).toEqual([expect.objectContaining({ label: 'Today', value: '840K of 1M', tone: 'warning' })]);
    expect(free.note).toBe('Shared by your free agents · counted by Beeline');
    expect(free.muted).toBe(false);
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
      muted: false,
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
  it('shows a native spinner and what it reads, announces it, and sends once', async () => {
    let resolve!: (value: unknown) => void;
    const onRefresh = vi.fn(() => new Promise((done) => { resolve = done; }));
    let renderer: any;
    const usage = { updatedAt: now, windows: [win('five_hour', .14)], machine: 'squire' };
    act(() => { renderer = create(<AgentUsageSection usage={usage} harness="claude" onRefresh={onRefresh} />); });
    await act(async () => { renderer.root.findByType('Button').props.onPress(); });
    expect(renderer.root.findAllByType('Button')).toHaveLength(0);
    expect(renderer.root.findByType('ActivityIndicator').props.accessibilityLabel).toBe('Refreshing usage');
    expect(renderer.root.findByProps({ testID: 'agent-usage-refreshing' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'agent-usage-stamp' }).props.children).toBe('Refreshing · reading Claude on squire');
    expect(announce).toHaveBeenCalledWith('Refreshing usage');
    await act(async () => resolve({ status: 'fresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ testID: 'agent-usage-stamp' }).props.children).toMatch(/^updated /);
    act(() => renderer.unmount());
  });
  it('R-USAGE-5: shows an offline machine at once, then clears it on a later success', async () => {
    const onRefresh = vi.fn().mockResolvedValueOnce({ status: 'offline' }).mockResolvedValue({ status: 'fresh' });
    let renderer: any;
    const usage = { updatedAt: now, windows: [win('five_hour', .14)], machine: 'squire' };
    act(() => { renderer = create(<AgentUsageSection usage={usage} harness="claude" onRefresh={onRefresh} />); });
    await act(async () => renderer.root.findByType('Button').props.onPress());
    const stamp = () => renderer.root.findByProps({ testID: 'agent-usage-stamp' });
    expect(stamp().props.children).toMatch(/^updated .* · squire is offline$/);
    expect(stamp().props.accessibilityRole).toBe('alert');
    await act(async () => renderer.root.findByType('Button').props.onPress());
    expect(stamp().props.children).toMatch(/^updated [^·]*$/);
    expect(stamp().props.accessibilityRole).toBeUndefined();
    act(() => renderer.unmount());
  });
  it('gives up after its own deadline, and a late success still clears the line', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const onRefresh = vi.fn(() => new Promise((done) => { resolve = done; }));
    let renderer: any;
    const usage = { updatedAt: now, windows: [win('weekly', .1)], machine: 'squire' };
    act(() => { renderer = create(<AgentUsageSection usage={usage} harness="codex" onRefresh={onRefresh} />); });
    await act(async () => renderer.root.findByType('Button').props.onPress());
    act(() => vi.advanceTimersByTime(USAGE_REFRESH_CLIENT_TIMEOUT_MS));
    const stamp = () => renderer.root.findByProps({ testID: 'agent-usage-stamp' }).props.children;
    expect(stamp()).toMatch(/· couldn't read: squire didn't answer$/);
    await act(async () => resolve({ status: 'fresh' }));
    expect(stamp()).toMatch(/^updated [^·]*$/);
    act(() => renderer.unmount());
  });
  it('a failure stops showing once newer numbers arrive', async () => {
    const onRefresh = vi.fn().mockRejectedValue(new Error('network'));
    let renderer: any;
    const usage = { updatedAt: now, windows: [win('weekly', .1)] };
    act(() => { renderer = create(<AgentUsageSection usage={usage} onRefresh={onRefresh} />); });
    await act(async () => renderer.root.findByType('Button').props.onPress());
    const stamp = () => renderer.root.findByProps({ testID: 'agent-usage-stamp' }).props.children;
    expect(stamp()).toMatch(/· couldn't read: Beeline didn't answer$/);
    act(() => renderer.update(<AgentUsageSection usage={{ ...usage, updatedAt: now + 1 }} onRefresh={onRefresh} />));
    expect(stamp()).toMatch(/^updated [^·]*$/);
    act(() => renderer.unmount());
  });
  it('reads once on open when the numbers are over 2 minutes old', async () => {
    const onRefresh = vi.fn(async () => ({ status: 'fresh' }));
    let renderer: any;
    await act(async () => { renderer = create(<AgentUsageSection usage={{ updatedAt: now - 30, windows: [win('weekly', .1)] }} onRefresh={onRefresh} />); });
    expect(onRefresh).not.toHaveBeenCalled();
    act(() => renderer.unmount());
    await act(async () => { renderer = create(<AgentUsageSection usage={{ updatedAt: now - 121, windows: [win('weekly', .1)] }} onRefresh={onRefresh} />); });
    await act(async () => renderer.update(<AgentUsageSection usage={{ updatedAt: now - 125, windows: [win('weekly', .2)] }} onRefresh={onRefresh} />));
    expect(onRefresh).toHaveBeenCalledTimes(1);
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
