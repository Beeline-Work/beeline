import { usageHarness, usageProvider, usageTime } from '@/buzz/agent-usage';
import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Button } from './Button';
import { InlineRow } from './IndexRow';
import { AccessibilityInfo, ActivityIndicator, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  type AgentUsage,
  type UsageRefreshOutcome,
  readUsageRefreshOutcome,
  usageDollars,
  usageNames,
  usageTokens,
  usageWhy,
  usageWindowLabel,
} from '@beeline/api-contract/phone';
import { RoomListSectionHeader } from './RoomListSectionHeader';
import { Typography } from '@/constants/Typography';

/** Longer than the server's 20 s wait for the helper, so its answer always arrives first. */
export const USAGE_REFRESH_CLIENT_TIMEOUT_MS = 25_000;
/** Opening a Profile whose numbers are older than this reads them again once. */
export const USAGE_AUTO_REFRESH_SECONDS = 2 * 60;

type Tone = 'warning' | 'danger' | undefined;
/** One column of the Usage cell: a window, an allowance, or a spend figure. */
export type UsageColumn = {
  label: string;
  value: string;
  /** Fraction used; absent for a plain figure with no bar. */
  fill?: number;
  foot?: string;
  tone?: Tone;
};

/**
 * The Usage cell's columns and bottom lines for one snapshot (approved mock).
 * `outcome` is a refresh answer that is not fresh; with it, or with a stored
 * read that was not fresh, the numbers are `muted` and the stamp says why.
 */
export function usageCell(
  usage: AgentUsage,
  harness?: string,
  now = Date.now() / 1000,
  outcome?: UsageRefreshOutcome,
): { columns: UsageColumn[]; note: string; shared?: string; stamp?: string; refreshable?: boolean; muted: boolean } {
  const context = usage.context
    ? `Context ${usageTokens(usage.context.used)} of ${usageTokens(usage.context.size)}`
    : undefined;
  const why = outcome
    ? usageWhy(outcome, usage.machine, usageTime)
    : usage.read
      ? usageWhy(usage.read, usage.machine, usageTime)
      : undefined;
  const muted = Boolean(why);
  const stamp = `updated ${usageTime(usage.updatedAt)}${why ? ` · ${why}` : ''}`;
  const shared = usage.sharedWith?.length ? `Shared with ${usageNames(usage.sharedWith)}` : undefined;
  if (usage.free) {
    const f = usage.free;
    const fraction = f.used / f.limit;
    return {
      columns: [
        f.paused
          ? { label: 'Today', value: 'Paused', fill: 1, foot: `back ${usageTime(f.resetsAt)}`, tone: 'danger' }
          : {
              label: 'Today',
              value: `${usageTokens(f.used)} of ${usageTokens(f.limit)}`,
              fill: fraction,
              foot: `resets ${usageTime(f.resetsAt)}`,
              tone: fraction >= 0.8 ? 'warning' : undefined,
            },
      ],
      note: 'Shared by your free agents · counted by Beeline',
      muted: false,
    };
  }
  if (usage.spend) {
    const s = usage.spend;
    const columns: UsageColumn[] = [
      ...(s.today !== undefined ? [{ label: 'Today', value: usageDollars(s.today) }] : []),
      ...(s.week !== undefined ? [{ label: 'This week', value: usageDollars(s.week) }] : []),
    ];
    if (s.rejected) {
      columns.push({
        label: 'Key limit',
        value: 'Reached',
        fill: 1,
        ...(s.limit ? { foot: `of ${usageDollars(s.limit)}` } : {}),
        tone: 'danger',
      });
    } else if (s.limit) {
      const used = 1 - (s.remaining ?? 0) / s.limit;
      columns.push({
        label: 'Key limit',
        value: `${usageDollars(s.remaining ?? 0)} left`,
        fill: used,
        foot: `of ${usageDollars(s.limit)}`,
        tone: used >= 0.8 ? 'warning' : undefined,
      });
    }
    return {
      columns,
      note: [context, 'OpenRouter key, shared'].filter(Boolean).join(' · '),
      stamp, refreshable: true,
      muted,
    };
  }
  if (usage.windows.length || usage.credits) {
    const counts = new Map<number, number>();
    for (const w of usage.windows) {
      if (w.resetsAt) counts.set(w.resetsAt, (counts.get(w.resetsAt) ?? 0) + 1);
    }
    let sharedReset: number | undefined;
    let most = 1;
    for (const [time, count] of counts) {
      if (count > most) { sharedReset = time; most = count; }
    }
    const credits: UsageColumn[] = usage.credits
      ? [{ label: 'Credits', value: `${Math.floor(usage.credits.remaining).toLocaleString('en-US')} left` }]
      : [];
    const plan = usage.plan ? `${usage.plan} plan` : undefined;
    return {
      columns: [...usage.windows.map((w): UsageColumn => {
        const label = usageWindowLabel(w.rateLimitType, w.label);
        if (w.status === 'rejected')
          return {
            label,
            value: 'Limit',
            fill: 1,
            ...(w.resetsAt ? { foot: `back ${usageTime(w.resetsAt)}` } : {}),
            tone: 'danger',
          };
        const fraction = w.utilization ?? 0;
        return {
          label,
          value: `${Math.round(fraction * 100)}%`,
          fill: fraction,
          ...(w.resetsAt && w.resetsAt !== sharedReset ? { foot: `resets ${usageTime(w.resetsAt)}` } : {}),
          // Brass marks a number near its limit; an untrusted number is not marked.
          tone: fraction >= 0.8 && !muted ? 'warning' : undefined,
        };
      }), ...credits],
      note: [context, usageHarness(harness), plan].filter(Boolean).join(' · '),
      ...(shared ? { shared } : {}),
      stamp: [!muted && sharedReset ? `resets ${usageTime(sharedReset)}` : undefined, stamp].filter(Boolean).join(' · '),
      refreshable: true,
      muted,
    };
  }
  return {
    columns: [],
    note: [`${usageHarness(harness)} doesn't report usage to Beeline`, context].filter(Boolean).join(' · '),
    muted: false,
  };
}

/**
 * Owner-only USAGE section: one cell, one column per window (approved mock). A
 * harness that never reported anything still gets the section and its note.
 * A refresh shows a spinner and what it is reading, then the new numbers or
 * why there are none; a Profile whose numbers are over 2 min old reads once.
 */
export function AgentUsageSection({ usage, harness, onRefresh }: {
  usage?: AgentUsage; harness?: string; onRefresh?: () => Promise<unknown>;
}) {
  const [refreshing, setRefreshing] = React.useState(false);
  // A refresh answer that was not fresh, held while the numbers it is about are shown.
  const [answer, setAnswer] = React.useState<{ outcome: UsageRefreshOutcome; about?: number }>();
  const attempt = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const updatedAt = React.useRef(usage?.updatedAt);
  updatedAt.current = usage?.updatedAt;
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const { columns, note, shared, stamp, refreshable, muted } = usageCell(
    usage ?? { updatedAt: 0, windows: [] },
    harness,
    undefined,
    answer && answer.about === usage?.updatedAt ? answer.outcome : undefined,
  );
  const canRefresh = Boolean(refreshable && onRefresh);
  const refresh = React.useCallback(() => {
    if (!onRefresh || timer.current !== undefined) return;
    const current = ++attempt.current;
    setRefreshing(true);
    AccessibilityInfo.announceForAccessibility?.('Refreshing usage');
    const settle = (outcome: UsageRefreshOutcome) => {
      if (current !== attempt.current) return;
      clearTimeout(timer.current);
      timer.current = undefined;
      setRefreshing(false);
      // Success clears any earlier failure; anything else stays beside the numbers it is about.
      setAnswer(outcome.status === 'fresh' ? undefined : { outcome, about: updatedAt.current });
    };
    // A late answer still settles this attempt and replaces the timeout's line.
    timer.current = setTimeout(() => settle({ status: 'no_answer' }), USAGE_REFRESH_CLIENT_TIMEOUT_MS);
    void Promise.resolve()
      .then(onRefresh)
      .then(
        (value) => settle(readUsageRefreshOutcome(value) ?? { status: 'fresh' }),
        () => { if (timer.current !== undefined) settle({ status: 'failed', reason: "Beeline didn't answer" }); },
      );
  }, [onRefresh]);
  const hasUsage = usage !== undefined;
  React.useEffect(() => {
    if (!hasUsage || !canRefresh) return;
    if (Date.now() / 1000 - (updatedAt.current ?? 0) > USAGE_AUTO_REFRESH_SECONDS) refresh();
    // Once per Profile: the section is keyed by agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasUsage, canRefresh]);
  const machine = usage?.machine;
  const reading = `Refreshing · reading ${usageProvider(harness, Boolean(usage?.spend))}${machine ? ` on ${machine}` : ''}`;
  return (
    <View style={styles.section} testID="agent-usage">
      <RoomListSectionHeader title="Usage" inset="row" spacing="flush" />
      <View style={styles.cell}>
        {columns.length ? (
          <View style={styles.columns}>
            {columns.map((c) => (
              <View
                key={c.label}
                style={[styles.column, columns.length > 2 && styles.halfColumn]}
                testID={`agent-usage-${c.label}`}
                {...(c.fill !== undefined
                  ? {
                      accessibilityRole: 'progressbar' as const,
                      accessibilityLabel: `${c.label}: ${c.value}${c.foot ? `, ${c.foot}` : ''}`,
                      accessibilityValue: { min: 0, max: 100, now: Math.round(Math.min(1, c.fill) * 100) },
                    }
                  : { accessible: true, accessibilityLabel: `${c.label}: ${c.value}` })}
              >
                <Text numberOfLines={1} style={styles.label}>{c.label}</Text>
                <Text numberOfLines={1} style={[styles.value, muted && styles.mutedValue, c.tone && styles[c.tone]]}>
                  {c.value}
                </Text>
                {c.fill !== undefined ? (
                  <View style={styles.track}>
                    <View
                      style={[
                        styles.fill,
                        { width: `${Math.min(100, Math.max(0, Math.round(c.fill * 100)))}%` },
                        muted && styles.fillMuted,
                        c.tone === 'warning' && styles.fillWarning,
                        c.tone === 'danger' && styles.fillDanger,
                      ]}
                    />
                  </View>
                ) : null}
                {c.foot ? (
                  <Text numberOfLines={1} style={[styles.label, c.tone === 'danger' && styles.danger]}>
                    {c.foot}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}
        <InlineRow style={styles.footer}>
          <View style={styles.footerText}>
            <Text style={styles.note} testID="agent-usage-note">{note}</Text>
            {shared ? <Text style={styles.note} testID="agent-usage-shared">{shared}</Text> : null}
            {refreshing ? (
              <Text style={styles.note} testID="agent-usage-stamp">{reading}</Text>
            ) : stamp ? (
              <Text
                style={[styles.note, muted && styles.warning]}
                testID="agent-usage-stamp"
                {...(muted ? { accessibilityRole: 'alert' as const } : {})}
              >
                {stamp}
              </Text>
            ) : null}
          </View>
          {canRefresh ? (
            refreshing ? (
              <View style={styles.refreshTarget} testID="agent-usage-refreshing">
                <ActivityIndicator size="small" color={styles.refreshGlyph.color} accessibilityLabel="Refreshing usage" />
              </View>
            ) : (
              <Button label="" iconOnly variant="quiet" accessibilityLabel="Refresh usage" onPress={refresh}
                icon={<Ionicons name="refresh-outline" size={20} color={styles.refreshGlyph.color} />} />
            )
          ) : null}
        </InlineRow>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: { alignItems: 'center', gap: theme.buzz.space.xs },
  footerText: { flex: 1, gap: theme.buzz.space.xs },
  refreshGlyph: { color: theme.buzz.textSecondary },
  refreshTarget: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  section: { paddingTop: theme.buzz.space.lg, gap: theme.buzz.space.xs },
  cell: {
    paddingHorizontal: theme.buzz.space.sm,
    paddingVertical: theme.buzz.space.sm,
    gap: theme.buzz.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  columns: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.buzz.space.md },
  column: { flex: 1, minWidth: 0, gap: theme.buzz.space.xs },
  // Longer sets wrap two to a row so labels and reset times stay whole.
  halfColumn: { flexBasis: '40%', maxWidth: '48%' },
  label: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  value: { ...Typography.default(), ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  // Numbers from a read that did not come back fresh: still readable, not current.
  mutedValue: { color: theme.buzz.ledgerQuiet },
  track: {
    height: 3,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgHighlight,
    overflow: 'hidden',
  },
  fill: { height: 3, backgroundColor: theme.buzz.textSecondary },
  fillMuted: { backgroundColor: theme.buzz.textMuted },
  fillWarning: { backgroundColor: theme.buzz.accent },
  fillDanger: { backgroundColor: theme.buzz.dialogDanger },
  note: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  warning: { color: theme.buzz.accent },
  danger: { color: theme.buzz.dialogDanger },
}));
