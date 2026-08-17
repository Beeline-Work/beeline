import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AgentActivityItem } from '@/sync/transport/rig-transport';
import { buildTurnActivity, type TurnActivityAction } from '@/buzz/activity-timeline';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import { darkTheme } from '@/theme';
import { HullActivityTip } from './MonoHull';

const diffColors = darkTheme.colors.diff;

type ActivityTimelineProps = {
  active?: boolean;
  items: readonly AgentActivityItem[];
  testID?: string;
};

function ObjectiveChecklist({ plan }: { plan: NonNullable<AgentActivityItem['plan']> }) {
  const title = plan.objective?.trim() || 'Current objective';
  return (
    <View style={styles.objective} testID="corner-objective-checklist">
      <Text style={styles.objectiveEyebrow}>OBJECTIVE</Text>
      <Text style={styles.objectiveTitle}>{title}</Text>
      {plan.items.map((item, index) => {
        const completed = item.status === 'completed';
        return (
          <View key={`${index}-${item.step}`} style={styles.checklistRow}>
            <Text style={[styles.checklistMark, completed && styles.checklistDone]}>
              {completed ? '✓' : item.status === 'in_progress' ? '◐' : '□'}
            </Text>
            <Text style={[styles.checklistText, completed && styles.checklistDone]}>
              {item.step}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function DetailText({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <View style={styles.detailBlock}>
      <Text style={styles.detailLabel}>{label}</Text>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
        <Text selectable style={styles.detailCode}>
          {value}
        </Text>
      </ScrollView>
    </View>
  );
}

function ActionDetail({ action, onBack }: { action: TurnActivityAction; onBack: () => void }) {
  return (
    <View style={styles.detailView} testID={`activity-detail-${action.kind}`}>
      <Pressable accessibilityRole="button" onPress={onBack} style={styles.backRow}>
        <Text style={styles.backText}>‹ TURN ACTIVITY</Text>
      </Pressable>
      <Text selectable style={styles.detailTitle}>
        {action.path ?? action.title}
      </Text>
      <ScrollView nestedScrollEnabled style={styles.detailScroll}>
        {action.kind === 'file' ? (
          action.diff ? (
            <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
              <View style={styles.diffBody}>
                {action.diff.split('\n').map((line, index) => (
                  <Text
                    key={`${index}-${line.slice(0, 24)}`}
                    selectable
                    style={[
                      styles.diffLine,
                      line.startsWith('+') && !line.startsWith('+++')
                        ? styles.diffAdded
                        : line.startsWith('-') && !line.startsWith('---')
                          ? styles.diffRemoved
                          : line.startsWith('@@')
                            ? styles.diffHeader
                            : undefined,
                    ]}
                  >
                    {line || ' '}
                  </Text>
                ))}
              </View>
            </ScrollView>
          ) : (
            <Text style={styles.emptyDetail}>No inline patch was supplied for this edit.</Text>
          )
        ) : (
          <>
            <DetailText label="COMMAND" value={action.command} />
            <DetailText label="INPUT" value={action.input} />
            <DetailText label="OUTPUT" value={action.output} />
            {!action.command && !action.input && !action.output ? (
              <Text style={styles.emptyDetail}>No additional detail was supplied.</Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * A turn's whole tool run as one collapsed ledger line.
 *
 * Everything the tools said — the agent's own mid-run notes, commands, inputs,
 * and raw output — stays behind this line's disclosure. The transcript never
 * prints a wall of output: one line, expandable to the action list, then to a
 * single action's detail.
 *
 * Memoized: rendered once per activity row inside FlatList's renderItem, which
 * is recreated on every presence tick — without this, every activity row's
 * (already non-trivial) render re-executes on updates unrelated to that row's
 * own activity. `items` must stay reference-stable across unrelated re-renders
 * for this to pay off (see LedgerActivity).
 */
export const ActivityTimeline = React.memo(function ActivityTimeline({
  active = false,
  items,
  testID,
}: ActivityTimelineProps) {
  const turn = useMemo(() => buildTurnActivity(items), [items]);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<TurnActivityAction | null>(null);
  const inspectable = turn.actions.length > 0 || turn.updates.length > 0;

  if (!inspectable && !turn.plan) return null;

  return (
    <View style={styles.timeline} testID={testID}>
      {turn.plan ? <ObjectiveChecklist plan={turn.plan} /> : null}
      {selected ? (
        <ActionDetail action={selected} onBack={() => setSelected(null)} />
      ) : expanded ? (
        <View style={styles.actionList} testID="activity-secondary-view">
          <Pressable
            accessibilityLabel="Collapse turn activity"
            accessibilityRole="button"
            onPress={() => setExpanded(false)}
            style={styles.listHeading}
          >
            <Text style={styles.listHeadingText}>TURN ACTIVITY</Text>
            <Text style={styles.disclosure}>⌃</Text>
          </Pressable>
          {turn.updates.map((update, index) => (
            <View key={`update-${index}`} style={styles.updateRow} testID={`activity-update-${index}`}>
              <Text selectable style={styles.updateText}>
                {update}
              </Text>
            </View>
          ))}
          {turn.actions.map((action) => (
            <Pressable
              accessibilityLabel={`Inspect ${action.kind} ${action.path ?? action.title}`}
              accessibilityRole="button"
              key={action.id}
              onPress={() => setSelected(action)}
              style={styles.actionRow}
              testID={`activity-action-${action.id}`}
            >
              <Text style={styles.actionGlyph}>{action.kind === 'file' ? '▧' : '›_'}</Text>
              <View style={styles.actionCopy}>
                <Text numberOfLines={1} style={styles.actionTitle}>
                  {action.path ?? action.title}
                </Text>
                {action.kind === 'file' && action.status ? (
                  <Text style={styles.actionMeta}>{action.status.toUpperCase()}</Text>
                ) : null}
              </View>
              <Text style={styles.disclosure}>›</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Pressable
          accessibilityLabel={`${turn.summary} View turn activity`}
          accessibilityRole="button"
          disabled={!inspectable}
          onPress={() => setExpanded(true)}
          style={styles.summaryRow}
          testID="activity-turn-summary"
        >
          <View style={[styles.node, active && styles.activeNode]} />
          <Text numberOfLines={1} style={styles.summaryText}>
            {turn.summary}
          </Text>
          {active ? (
            <HullActivityTip />
          ) : inspectable ? (
            <Text style={styles.disclosure}>⌄</Text>
          ) : null}
        </Pressable>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  timeline: {
    width: '100%',
    minWidth: 0,
    paddingVertical: 4,
    backgroundColor: groknight.bgTerminal,
  },
  objective: {
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: groknight.borderQuiet,
    backgroundColor: groknight.bgRaised,
  },
  objectiveEyebrow: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 1,
  },
  objectiveTitle: {
    ...Typography.default(),
    color: groknight.textPrimary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
    marginBottom: 6,
  },
  checklistRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginTop: 3 },
  checklistMark: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 10,
    lineHeight: 15,
  },
  checklistText: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    color: groknight.textSecondary,
    fontSize: 11,
    lineHeight: 15,
  },
  checklistDone: { color: groknight.textMuted, textDecorationLine: 'line-through' },
  // One line, no box: a turn's tool run is a repeating unit of the ledger,
  // and the whole point is that it stays quiet until asked.
  summaryRow: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  node: {
    width: 7,
    height: 7,
    borderWidth: 1,
    borderColor: groknight.borderQuiet,
    backgroundColor: groknight.bgTerminal,
  },
  activeNode: { borderColor: groknight.accent, backgroundColor: groknight.accent },
  summaryText: {
    ...Typography.mono(),
    flex: 1,
    minWidth: 0,
    color: groknight.textSecondary,
    fontSize: 10,
    lineHeight: 14,
  },
  disclosure: {
    ...Typography.mono(),
    flexShrink: 0,
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  // The expanded drill-down is a transient, non-repeating region the reader
  // asked for, so it does earn a bounded surface.
  actionList: { borderWidth: 1, borderColor: groknight.borderQuiet },
  updateRow: {
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: groknight.borderQuiet,
  },
  updateText: {
    ...Typography.default(),
    color: groknight.textSecondary,
    fontSize: 11,
    lineHeight: 17,
  },
  listHeading: {
    minHeight: 34,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderQuiet,
  },
  listHeadingText: {
    ...Typography.mono(),
    flex: 1,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.8,
  },
  actionRow: {
    minHeight: 42,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: groknight.borderQuiet,
  },
  actionGlyph: {
    ...Typography.mono(),
    width: 20,
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 14,
  },
  actionCopy: { flex: 1, minWidth: 0 },
  actionTitle: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 10,
    lineHeight: 14,
  },
  actionMeta: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 8,
    lineHeight: 11,
    marginTop: 2,
  },
  detailView: { borderWidth: 1, borderColor: groknight.borderQuiet },
  backRow: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderQuiet,
  },
  backText: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.6,
  },
  detailTitle: {
    ...Typography.mono(),
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 15,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  detailScroll: { maxHeight: 360 },
  detailBlock: { paddingHorizontal: 10, paddingBottom: 10 },
  detailLabel: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 8,
    lineHeight: 11,
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  detailCode: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    backgroundColor: groknight.bgBase,
    fontSize: 9,
    lineHeight: 13,
    padding: 8,
  },
  diffBody: { minWidth: '100%', paddingVertical: 4 },
  diffLine: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 9,
    lineHeight: 14,
    paddingHorizontal: 8,
  },
  // Diffs are a deliberate color exception to Grok Mono Hull's zero-chroma
  // rule (captain override), same as ChangeReviewPanel.tsx's diff viewer —
  // share its tokens rather than hand-picking a second, slightly different
  // green/red pair. Hunk headers stay on the neutral grayscale palette.
  diffAdded: { backgroundColor: diffColors.addedBg, color: diffColors.addedBorder },
  diffRemoved: { backgroundColor: diffColors.removedBg, color: diffColors.removedBorder },
  diffHeader: { backgroundColor: groknight.bgHover, color: groknight.textMuted },
  emptyDetail: {
    ...Typography.default(),
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 10,
    paddingBottom: 12,
  },
});
