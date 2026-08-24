import React, { useMemo, useState } from 'react';
import { Modal as RNModal, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AgentActivityItem } from '@/sync/transport/rig-transport';
import { buildTurnActivity, type TurnActivityAction } from '@/buzz/activity-timeline';
import { Typography } from '@/constants/Typography';
import { HullActionSheet } from './HullActionSheet';
import { PixelLoader } from './MonoHull';
import { MonoMarkdown } from './MonoMarkdown';

type ActivityTimelineProps = {
  active?: boolean;
  items: readonly AgentActivityItem[];
  handle?: string;
  stamp?: string;
  testID?: string;
};

function stepGlyph(step: TurnActivityAction): string {
  if (step.kind === 'thought') return '◈';
  const kind = step.toolKind?.toLowerCase();
  if (step.weight === 'command' || kind === 'execute' || kind === 'ran' || step.command)
    return '>_';
  if (step.weight === 'mutation' || ['edit', 'write', 'move', 'delete'].includes(kind ?? '')) {
    return '▧';
  }
  return '◈';
}

function durationText(ms: number | undefined): string | undefined {
  if (!ms || ms <= 0) return undefined;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function rawStepText(step: TurnActivityAction): string {
  const sections: string[] = [];
  if (step.command) sections.push(step.command);
  if (step.input) sections.push(step.input);
  if (step.output) sections.push(step.output);
  for (const file of step.files ?? []) {
    sections.push(
      [file.path, file.status, file.diff]
        .filter((part): part is string => Boolean(part))
        .join('\n'),
    );
  }
  return sections.join('\n\n') || 'No raw output was supplied for this step.';
}

function resolvedOutcome(
  step: TurnActivityAction,
  active: boolean,
  isLast: boolean,
): TurnActivityAction['outcome'] {
  if (step.outcome === 'failure' || step.outcome === 'running') return step.outcome;
  if (active && isLast && step.kind === 'tool' && !step.status) return 'running';
  return 'success';
}

function outcomeCopy(outcome: TurnActivityAction['outcome']): string {
  if (outcome === 'failure') return 'failed';
  if (outcome === 'running') return 'running';
  return 'succeeded';
}

function groupStepLabel(step: TurnActivityAction): string {
  if (step.kind === 'thought') return 'thought';
  if (step.weight !== 'observation') return step.title.toLowerCase();
  const kind = step.toolKind?.toLowerCase();
  if (kind === 'search' || kind === 'searched') return 'search';
  if (kind === 'list' || kind === 'listed') return 'list';
  if (kind === 'fetch' || kind === 'fetched') return 'fetch';
  if (kind === 'read' || kind === 'reading') return 'read';
  return step.label;
}

function LedgerStepRow({
  active,
  isLast,
  onPress,
  step,
}: {
  active: boolean;
  isLast: boolean;
  onPress: () => void;
  step: TurnActivityAction;
}) {
  const outcome = resolvedOutcome(step, active, isLast);
  const duration = durationText(step.durationMs);
  const accessibilityLabel = [step.label, outcomeCopy(outcome), step.reason]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: outcome === 'running' }}
      onPress={onPress}
      style={({ pressed }) => [styles.stepRow, pressed && styles.rowPressed]}
      testID={`activity-step-${step.id}`}
    >
      <Text accessibilityElementsHidden style={styles.stepGlyph}>
        {stepGlyph(step)}
      </Text>
      <Text numberOfLines={1} style={styles.stepLabel}>
        {step.label}
      </Text>
      {outcome === 'running' ? (
        <View style={styles.runningMark} testID={`activity-verdict-${step.id}`}>
          <PixelLoader compact />
        </View>
      ) : (
        <Text
          accessibilityElementsHidden
          style={[styles.verdict, outcome === 'failure' && styles.verdictFailed]}
          testID={`activity-verdict-${step.id}`}
        >
          {outcome === 'failure' ? '×' : '✓'}
        </Text>
      )}
      {step.reason ? (
        <Text numberOfLines={1} style={styles.stepReason} testID={`activity-reason-${step.id}`}>
          {step.reason}
        </Text>
      ) : null}
      {duration ? <Text style={styles.duration}>{duration}</Text> : null}
    </Pressable>
  );
}

function StepGroupRow({
  active,
  expanded,
  handle,
  onPress,
  stamp,
  steps,
}: {
  active: boolean;
  expanded: boolean;
  handle?: string;
  onPress: () => void;
  stamp?: string;
  steps: readonly TurnActivityAction[];
}) {
  const failed = steps.filter((step) => step.outcome === 'failure').length;
  const running = active || steps.some((step) => step.outcome === 'running');
  const labels = steps.map((step) => {
    const label = groupStepLabel(step);
    const duration = durationText(step.durationMs);
    return duration ? `${label} ${duration}` : label;
  });
  const summary = [handle?.toUpperCase(), ...new Set(labels)].filter(Boolean).join(' · ');
  return (
    <Pressable
      accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${summary}`}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={({ pressed }) => [styles.stepRow, styles.groupRow, pressed && styles.rowPressed]}
      testID="activity-step-group"
    >
      <Text accessibilityElementsHidden style={styles.chevron}>
        {expanded ? '⌄' : '›'}
      </Text>
      <Text numberOfLines={1} style={styles.groupLabel}>
        {summary}
      </Text>
      {running && !failed ? (
        <View style={styles.runningMark}>
          <PixelLoader compact />
        </View>
      ) : (
        <Text
          accessibilityElementsHidden
          style={[styles.verdict, failed > 0 && styles.verdictFailed]}
        >
          {failed ? '×' : '✓'}
        </Text>
      )}
      {stamp ? (
        <Text numberOfLines={1} style={styles.groupStamp} testID="activity-group-stamp">
          {stamp}
        </Text>
      ) : null}
    </Pressable>
  );
}

function RawOutputSheet({
  onClose,
  step,
}: {
  onClose: () => void;
  step: TurnActivityAction | null;
}) {
  const insets = useSafeAreaInsets();
  return (
    <RNModal animationType="slide" onRequestClose={onClose} transparent visible={Boolean(step)}>
      <View style={[styles.sheetRoot, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Pressable
          accessibilityLabel="Close raw output"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <HullActionSheet style={styles.sheet} testID="activity-raw-output-sheet">
          <View style={styles.sheetHeading}>
            <View style={styles.sheetHeadingCopy}>
              <Text style={styles.sheetEyebrow}>RAW OUTPUT</Text>
              <Text numberOfLines={1} style={styles.sheetTitle}>
                {step?.label}
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Close raw output"
              accessibilityRole="button"
              onPress={onClose}
              style={styles.sheetClose}
            >
              <Text style={styles.sheetCloseText}>×</Text>
            </Pressable>
          </View>
          <ScrollView nestedScrollEnabled style={styles.rawScroll}>
            <Text selectable style={styles.rawText}>
              {step ? rawStepText(step) : ''}
            </Text>
          </ScrollView>
        </HullActionSheet>
      </View>
    </RNModal>
  );
}

/**
 * Agent prose remains the transcript's spine. Consecutive machine steps become
 * a compact ledger: one mono line each, or one collapsed run when there are
 * more than three. Raw output always opens in the shared flat sheet.
 */
export const ActivityTimeline = React.memo(function ActivityTimeline({
  active = false,
  handle,
  items,
  stamp,
  testID,
}: ActivityTimelineProps) {
  const turn = useMemo(() => buildTurnActivity(items), [items]);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<TurnActivityAction | null>(null);
  const grouped = turn.steps.length > 0;
  const showSteps = expanded;

  if (!turn.narration.length && !turn.steps.length) return null;

  return (
    <View style={styles.timeline} testID={testID}>
      {turn.narration.map((prose, index) => (
        <MonoMarkdown
          key={`narration-${index}`}
          markdown={prose}
          textStyle={styles.narration}
          leadingInline={
            index === 0 && handle ? (
              <Text style={styles.narrationHandle}>
                {handle.toUpperCase()}
                {'  '}
              </Text>
            ) : null
          }
          testID={index === 0 ? 'activity-narration' : undefined}
        />
      ))}

      {grouped ? (
        <StepGroupRow
          active={active}
          expanded={expanded}
          handle={handle}
          onPress={() => setExpanded((value) => !value)}
          stamp={stamp}
          steps={turn.steps}
        />
      ) : null}

      {showSteps
        ? turn.steps.map((step, index) => (
            <LedgerStepRow
              active={active}
              isLast={index === turn.steps.length - 1}
              key={step.id}
              onPress={() => setSelected(step)}
              step={step}
            />
          ))
        : null}

      <RawOutputSheet onClose={() => setSelected(null)} step={selected} />
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    timeline: { width: '100%', minWidth: 0, paddingVertical: 4 },
    narration: {
      ...Typography.ledger(),
      width: '100%',
      minWidth: 0,
      color: groknight.ledgerBright,
      fontSize: 16,
      lineHeight: 25,
    },
    narrationHandle: {
      ...Typography.ledger('medium'),
      color: groknight.ledgerBright,
      fontSize: 16,
      lineHeight: 25,
      letterSpacing: -0.1,
    },
    stepRow: {
      minHeight: 44,
      minWidth: 0,
      paddingHorizontal: 4,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: groknight.borderQuiet,
    },
    groupRow: { paddingHorizontal: 0 },
    rowPressed: { backgroundColor: groknight.bgHover },
    stepGlyph: {
      ...Typography.mono(),
      width: 18,
      flexShrink: 0,
      color: groknight.ledgerGhost,
      fontSize: 10,
      lineHeight: 18,
    },
    chevron: {
      ...Typography.mono(),
      flexShrink: 0,
      marginRight: 8,
      color: groknight.ledgerGhost,
      fontSize: 13,
      lineHeight: 18,
    },
    stepLabel: {
      ...Typography.mono(),
      flexShrink: 1,
      minWidth: 48,
      color: groknight.ledgerQuiet,
      fontSize: 11,
      lineHeight: 18,
    },
    groupLabel: {
      ...Typography.mono(),
      flex: 1,
      minWidth: 0,
      color: groknight.ledgerGhost,
      fontSize: 11,
      lineHeight: 18,
    },
    groupStamp: {
      ...Typography.mono(),
      flexShrink: 0,
      marginLeft: 8,
      color: groknight.ledgerGhost,
      fontSize: 10,
      lineHeight: 18,
      fontVariant: ['tabular-nums'],
    },
    verdict: {
      ...Typography.mono(),
      flexShrink: 0,
      color: groknight.ledgerGhost,
      fontSize: 11,
      lineHeight: 18,
    },
    verdictFailed: { color: groknight.accent },
    runningMark: { flexShrink: 0, minWidth: 16, alignItems: 'center' },
    stepReason: {
      ...Typography.mono(),
      flex: 1,
      minWidth: 0,
      color: groknight.ledgerQuiet,
      fontSize: 10,
      lineHeight: 18,
    },
    duration: {
      ...Typography.mono(),
      flexShrink: 0,
      color: groknight.ledgerGhost,
      fontSize: 10,
      lineHeight: 18,
      fontVariant: ['tabular-nums'],
    },
    sheetRoot: {
      flex: 1,
      paddingHorizontal: 12,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(5, 5, 6, 0.84)',
    },
    sheet: { width: '100%', maxHeight: '78%' },
    sheetHeading: {
      minWidth: 0,
      paddingLeft: 12,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: groknight.borderQuiet,
    },
    sheetHeadingCopy: { flex: 1, minWidth: 0, paddingVertical: 10 },
    sheetEyebrow: {
      ...Typography.mono(),
      color: groknight.ledgerGhost,
      fontSize: 8,
      lineHeight: 12,
      letterSpacing: 0.8,
    },
    sheetTitle: {
      ...Typography.mono(),
      color: groknight.ledgerQuiet,
      fontSize: 11,
      lineHeight: 17,
      marginTop: 2,
    },
    sheetClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    sheetCloseText: {
      ...Typography.mono(),
      color: groknight.ledgerGhost,
      fontSize: 18,
      lineHeight: 22,
    },
    rawScroll: { maxHeight: 420 },
    rawText: {
      ...Typography.mono(),
      color: groknight.ledgerQuiet,
      fontSize: 10,
      lineHeight: 16,
      padding: 12,
    },
  };
});
