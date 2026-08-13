import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AgentActivityItem } from '@/sync/transport/rig-transport';
import { buildActivityTimeline, type ActivityTimelineEntry } from '@/buzz/activity-timeline';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import { HullActivityTip } from './MonoHull';
import { MonoMarkdown } from './MonoMarkdown';

type ActivityTimelineProps = {
  active?: boolean;
  items: readonly AgentActivityItem[];
  testID?: string;
};

function ReasoningRow({
  entry,
  active,
}: {
  entry: Extract<ActivityTimelineEntry, { kind: 'reasoning' }>;
  active: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(entry.detail);
  return (
    <View style={styles.entry}>
      <Pressable
        accessibilityLabel={`${entry.title}${entry.count > 1 ? `, ${entry.count} reasoning updates` : ''}`}
        accessibilityRole={hasDetail ? 'button' : undefined}
        accessibilityState={hasDetail ? { expanded } : undefined}
        disabled={!hasDetail}
        hitSlop={5}
        onPress={() => setExpanded((value) => !value)}
        style={styles.row}
        testID="activity-reasoning-row"
      >
        <View style={[styles.node, active && styles.activeNode]} />
        <Text numberOfLines={1} style={styles.reasoningTitle}>
          {entry.title}
        </Text>
        {entry.count > 1 ? <Text style={styles.meta}>{entry.count} notes</Text> : null}
        {active ? (
          <HullActivityTip />
        ) : hasDetail ? (
          <Text style={styles.disclosure}>{expanded ? '⌃' : '⌄'}</Text>
        ) : null}
      </Pressable>
      {expanded && hasDetail ? (
        <View style={styles.detail} testID="activity-reasoning-detail">
          <MonoMarkdown markdown={entry.detail} tone="reasoning" />
        </View>
      ) : null}
    </View>
  );
}

function ActionRow({
  entry,
  active,
  index,
}: {
  entry: Extract<ActivityTimelineEntry, { kind: 'action' }>;
  active: boolean;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(entry.detail);
  return (
    <View style={styles.entry}>
      <Pressable
        accessibilityLabel={`${entry.title}${entry.summary ? `, ${entry.summary}` : ''}`}
        accessibilityRole={hasDetail ? 'button' : undefined}
        accessibilityState={hasDetail ? { expanded } : undefined}
        disabled={!hasDetail}
        hitSlop={5}
        onPress={() => setExpanded((value) => !value)}
        style={styles.row}
        testID={`activity-action-${index}`}
      >
        <View style={[styles.node, styles.actionNode, active && styles.activeNode]} />
        <Text style={styles.actionGlyph}>⟩</Text>
        <Text numberOfLines={1} style={styles.actionTitle}>
          {entry.title}
        </Text>
        {entry.summary ? <Text style={styles.meta}>· {entry.summary}</Text> : null}
        {active ? (
          <HullActivityTip />
        ) : hasDetail ? (
          <Text style={styles.disclosure}>{expanded ? '⌃' : '⌄'}</Text>
        ) : null}
      </Pressable>
      {expanded && entry.detail ? (
        <View style={styles.detail} testID={`activity-action-detail-${index}`}>
          <MonoMarkdown markdown={entry.detail} tone="output" />
        </View>
      ) : null}
    </View>
  );
}

/** A single compact, connected stream for one logical run of ACP activity. */
export function ActivityTimeline({ active = false, items, testID }: ActivityTimelineProps) {
  const entries = useMemo(() => buildActivityTimeline(items), [items]);
  if (!entries.length) return null;

  return (
    <View style={styles.timeline} testID={testID}>
      <View pointerEvents="none" style={styles.rule} />
      {entries.map((entry, index) => {
        const isActiveTip = active && index === entries.length - 1;
        return entry.kind === 'reasoning' ? (
          <ReasoningRow
            active={isActiveTip}
            entry={entry}
            key={`reasoning-${index}-${entry.title}`}
          />
        ) : (
          <ActionRow
            active={isActiveTip}
            entry={entry}
            index={index}
            key={`action-${index}-${entry.title}`}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  timeline: {
    width: '100%',
    minWidth: 0,
    paddingVertical: 4,
    backgroundColor: groknight.bgTerminal,
  },
  rule: {
    position: 'absolute',
    left: 16,
    top: 14,
    bottom: 14,
    width: 1,
    backgroundColor: groknight.borderQuiet,
  },
  entry: { width: '100%', minWidth: 0 },
  row: {
    minWidth: 0,
    minHeight: 34,
    paddingLeft: 13,
    paddingRight: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  node: {
    width: 7,
    height: 7,
    borderWidth: 1,
    borderColor: groknight.borderQuiet,
    backgroundColor: groknight.bgTerminal,
  },
  actionNode: { width: 5, height: 5, marginHorizontal: 1 },
  activeNode: { borderColor: groknight.accent, backgroundColor: groknight.accent },
  reasoningTitle: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  actionGlyph: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 14,
  },
  actionTitle: {
    ...Typography.mono(),
    flex: 1,
    minWidth: 0,
    color: groknight.textSecondary,
    fontSize: 10,
    lineHeight: 14,
  },
  meta: {
    ...Typography.mono(),
    flexShrink: 0,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
  },
  disclosure: {
    ...Typography.mono(),
    width: 13,
    flexShrink: 0,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    textAlign: 'right',
  },
  detail: {
    minWidth: 0,
    marginLeft: 28,
    marginRight: 12,
    paddingBottom: 8,
    paddingTop: 1,
  },
});
