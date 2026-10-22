import { usageHarness, usageTime } from '@/buzz/agent-usage';
import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Button } from './Button';
import { InlineRow } from './IndexRow';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  type AgentUsage,
  usageDollars,
  usageIsOld,
  usageTokens,
  usageWindowLabel,
} from '@beeline/api-contract/phone';
import { RoomListSectionHeader } from './RoomListSectionHeader';
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

/** The Usage cell's columns and bottom line for one snapshot (approved gallery). */
export function usageCell(
  usage: AgentUsage,
  harness?: string,
  now = Date.now() / 1000,
): { columns: UsageColumn[]; note: string; stamp?: string; refreshable?: boolean; old: boolean } {
  const old = usageIsOld(usage, now);
  const context = usage.context
    ? `Context ${usageTokens(usage.context.used)} of ${usageTokens(usage.context.size)}`
    : undefined;
  const stamp = old
    ? `updated ${usageTime(usage.updatedAt)} · agent idle since then`
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
              foot: `resets ${usageTime(f.resetsAt)}`,
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
      note: [context, 'OpenRouter key, shared'].filter(Boolean).join(' · '),
      stamp, refreshable: true,
      old,
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
          tone: fraction >= 0.8 ? 'warning' : undefined,
        };
      }), ...credits],
      note: [context, usageHarness(harness), plan].filter(Boolean).join(' · '),
      stamp: [!old && sharedReset ? `resets ${usageTime(sharedReset)}` : undefined, stamp].filter(Boolean).join(' · '),
      refreshable: true,
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
 * Owner-only USAGE section: one cell, one column per window (approved gallery). A
 * harness that never reported anything still gets the section and its note.
 */
export function AgentUsageSection({ usage, harness, onRefresh }: {
  usage?: AgentUsage; harness?: string; onRefresh?: () => Promise<unknown>;
}) {
  const [refreshing, setRefreshing] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const pending = React.useRef<{ updatedAt: number | undefined; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const clear = React.useCallback(() => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = undefined;
  }, []);
  React.useEffect(() => () => clear(), [clear]);
  React.useEffect(() => {
    if (pending.current && usage?.updatedAt !== pending.current.updatedAt) {
      clear(); setRefreshing(false); setFailed(false);
    }
  }, [usage?.updatedAt, clear]);
  const refresh = () => {
    if (!onRefresh || pending.current) return;
    setFailed(false); setRefreshing(true);
    const attempt = {
      updatedAt: usage?.updatedAt,
      timer: setTimeout(() => { clear(); setRefreshing(false); setFailed(true); }, 15_000),
    };
    pending.current = attempt;
    void Promise.resolve().then(onRefresh).catch(() => {
      if (pending.current !== attempt) return;
      clear(); setRefreshing(false); setFailed(true);
    });
  };
  const { columns, note, stamp, refreshable, old } = usageCell(usage ?? { updatedAt: 0, windows: [] }, harness);
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
        <InlineRow style={styles.footer}>
          <View style={styles.footerText}>
            <Text style={styles.note} testID="agent-usage-note">{note}</Text>
            {stamp ? <Text style={[styles.note, old && styles.warning]} testID="agent-usage-stamp">{stamp}</Text> : null}
            {failed ? <Text style={[styles.note, styles.danger]} accessibilityRole="alert">Couldn't refresh</Text> : null}
          </View>
          {refreshable && onRefresh ? (
            <Button label="" iconOnly variant="quiet" accessibilityLabel="Refresh usage"
              disabled={refreshing} onPress={refresh} style={refreshing ? styles.dimmed : undefined}
              icon={<Ionicons name="refresh-outline" size={20} color={styles.refreshGlyph.color} />} />
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
  dimmed: { opacity: 0.4 },
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
