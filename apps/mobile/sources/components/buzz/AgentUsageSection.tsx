import { usageTime, usageHarness } from '@/buzz/agent-usage';
import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { type AgentUsage, USAGE_WINDOW_LABELS, usageTokens } from '@beeline/api-contract/phone';
import { RoomListSectionHeader } from './RoomListSectionHeader';
import { SettingsRow } from './SettingsRow';
import { Typography } from '@/constants/Typography';

export function UsageBar({
  label,
  value,
  fraction,
  stopped = false,
}: {
  label: string;
  value: string;
  fraction: number;
  stopped?: boolean;
}) {
  const color = stopped
    ? styles.danger.color
    : fraction >= 0.8
      ? styles.warning.color
      : styles.copy.color;
  return (
    <View>
      <SettingsRow
        title={label}
        description={value}
        descriptionContent={<Text style={[styles.copy, { color }]}>{value}</Text>}
      />
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={`${label}: ${value}`}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
        style={styles.track}
      >
        <View
          style={[
            styles.fill,
            { width: `${Math.min(100, Math.max(0, fraction * 100))}%`, backgroundColor: color },
          ]}
        />
      </View>
    </View>
  );
}

export function AgentUsageSection({ usage, harness }: { usage?: AgentUsage; harness?: string }) {
  const old = usage && Date.now() / 1000 - usage.updatedAt >= 30 * 60;
  return (
    <View style={styles.section} testID="agent-usage">
      <RoomListSectionHeader
        title={usage?.free ? 'FREE ALLOWANCE' : 'PLAN USAGE'}
        inset="content"
        spacing="flush"
      />
      {usage?.free ? (
        <>
          <UsageBar
            label="Today"
            value={`${usageTokens(usage.free.used)} of ${usageTokens(usage.free.limit)} tokens · resets ${usageTime(usage.free.resetsAt)}`}
            fraction={usage.free.used / usage.free.limit}
          />
          <Text style={styles.note}>Counted by Beeline · live</Text>
        </>
      ) : usage?.windows.length ? (
        <>
          {usage.windows.map((window) => (
            <UsageBar
              key={window.rateLimitType}
              label={USAGE_WINDOW_LABELS[window.rateLimitType] ?? window.rateLimitType}
              value={
                window.status === 'rejected'
                  ? `limit reached${window.resetsAt ? ` · back ${usageTime(window.resetsAt)}` : ''}`
                  : `${Math.round((window.utilization ?? 0) * 100)}%${window.resetsAt ? ` · resets ${usageTime(window.resetsAt)}` : ''}`
              }
              fraction={window.status === 'rejected' ? 1 : (window.utilization ?? 0)}
              stopped={window.status === 'rejected'}
            />
          ))}
          <Text style={[styles.note, old && styles.warning]}>
            {old
              ? `Last updated ${usageTime(usage.updatedAt)} · agent idle since`
              : `From Claude Code · updated ${usageTime(usage.updatedAt)}`}
          </Text>
        </>
      ) : (
        <Text style={styles.note}>{usageHarness(harness)} doesn't report usage to Beeline.</Text>
      )}
      {usage?.context ? (
        <>
          <RoomListSectionHeader title="CONTEXT" inset="content" spacing="flush" />
          <UsageBar
            label="This session"
            value={`${usageTokens(usage.context.used)} of ${usageTokens(usage.context.size)} tokens`}
            fraction={usage.context.used / usage.context.size}
          />
        </>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  section: { paddingTop: theme.buzz.space.md, gap: theme.buzz.space.md },
  copy: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
  note: {
    ...Typography.default(),
    ...theme.buzz.type.meta,
    color: theme.buzz.textSecondary,
    paddingHorizontal: theme.buzz.space.sm,
  },
  warning: { color: theme.buzz.accent },
  danger: { color: theme.buzz.dialogDanger },
  track: {
    height: 4,
    marginHorizontal: theme.buzz.space.sm,
    backgroundColor: theme.buzz.bgHighlight,
    borderRadius: theme.buzz.radius,
    overflow: 'hidden',
  },
  fill: { height: '100%' },
}));
