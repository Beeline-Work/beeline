import { usageHarness, usageTime } from '@/buzz/agent-usage';
import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  type AgentUsage,
  usageDollars,
  usageIsOld,
  usageTokens,
  usageWindowLabel,
} from '@beeline/api-contract/phone';
import { RoomListSectionHeader } from '../sources/components/buzz/RoomListSectionHeader';
import { Typography } from '@/constants/Typography';

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

/** The Usage cell's columns and bottom line for one snapshot (mock r7). */
export function usageCell(
  usage: AgentUsage,
  harness?: string,
  now = Date.now() / 1000,
): { columns: UsageColumn[]; note: string; old: boolean } {
  const old = usageIsOld(usage, now);
  const context = usage.context
    ? `Context ${usageTokens(usage.context.used)} of ${usageTokens(usage.context.size)}`
    : undefined;
  const stamp = old
    ? `last updated ${usageTime(usage.updatedAt)} · agent idle since`
    : `updated ${usageTime(usage.updatedAt)}`;
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
              foot: `↻ ${usageTime(f.resetsAt)}`,
              tone: fraction >= 0.8 ? 'warning' : undefined,
            },
      ],
      note: 'Shared by your free agents · counted by Beeline',
      old: false,
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
      note: [context, `OpenRouter key, shared · ${stamp}`].filter(Boolean).join(' · '),
      old,
    };
  }
  if (usage.windows.length || usage.credits) {
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
          ...(w.resetsAt ? { foot: `↻ ${usageTime(w.resetsAt)}` } : {}),
          tone: fraction >= 0.8 ? 'warning' : undefined,
        };
      }), ...credits],
      note: [context, usageHarness(harness), plan, stamp].filter(Boolean).join(' · '),
      old,
    };
  }
  return {
    columns: [],
    note: [`${usageHarness(harness)} doesn't report usage to Beeline`, context].filter(Boolean).join(' · '),
    old: false,
  };
}

/**
 * Owner-only USAGE section: one cell, one column per window (mock r7). A
 * harness that never reported anything still gets the section and its note.
 */
export function AgentUsageSection({ usage, harness }: { usage?: AgentUsage; harness?: string }) {
  const { columns, note, old } = usageCell(usage ?? { updatedAt: 0, windows: [] }, harness);
  return (
    <View style={styles.section} testID="agent-usage">
      <RoomListSectionHeader title="Usage" inset="row" spacing="flush" />
      <View style={styles.cell}>
        {columns.length ? (
          <View style={styles.columns}>
            {columns.map((c) => (
              <View
                key={c.label}
                style={[styles.column, columns.length > 3 && styles.halfColumn]}
                testID={`agent-usage-${c.label}`}
                {...(c.fill !== undefined
                  ? {
                      accessibilityRole: 'progressbar' as const,
                      accessibilityLabel: `${c.label}: ${c.value}${c.foot ? `, ${c.foot.replace('↻', 'resets')}` : ''}`,
                      accessibilityValue: { min: 0, max: 100, now: Math.round(Math.min(1, c.fill) * 100) },
                    }
                  : { accessible: true, accessibilityLabel: `${c.label}: ${c.value}` })}
              >
                <Text numberOfLines={1} style={styles.label}>{c.label}</Text>
                <Text numberOfLines={1} style={[styles.value, c.tone && styles[c.tone]]}>
                  {c.value}
                </Text>
                {c.fill !== undefined ? (
                  <View style={styles.track}>
                    <View
                      style={[
                        styles.fill,
                        { width: `${Math.min(100, Math.max(0, Math.round(c.fill * 100)))}%` },
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
        <Text style={[styles.note, old && styles.warning]} testID="agent-usage-note">
          {note}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
  // Four or more windows (Cursor) wrap two to a row so reset times stay whole.
  halfColumn: { flexBasis: '40%' },
  label: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  value: { ...Typography.default(), ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  track: {
    height: 3,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgHighlight,
    overflow: 'hidden',
  },
  fill: { height: 3, backgroundColor: theme.buzz.textSecondary },
  fillWarning: { backgroundColor: theme.buzz.accent },
  fillDanger: { backgroundColor: theme.buzz.dialogDanger },
  note: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  warning: { color: theme.buzz.accent },
  danger: { color: theme.buzz.dialogDanger },
}));
