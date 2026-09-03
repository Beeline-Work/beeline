import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentActivityItem } from '@/sync/transport/rig-transport';
import { buildTurnActivity, type TurnActivityAction } from '@/buzz/activity-timeline';
import { Typography } from '@/constants/Typography';
import { LedgerBylineView, type LedgerBylineMark } from './Ledger';
import { PixelLoader } from './MonoHull';
import { MonoMarkdown } from './MonoMarkdown';

type ActivityTimelineProps = {
  active?: boolean;
  items: readonly AgentActivityItem[];
  handle?: string;
  stamp?: string;
  testID?: string;
  messageDraft?: string;
  /** The streaming speaker's identity mark — the SAME mark the settled row's
   *  byline renders (`Ledger.LedgerBylineView`), so the draft lane carries the
   *  agent triangle and nothing changes visually when the draft settles. */
  mark?: LedgerBylineMark;
};

function stepGlyph(step: TurnActivityAction): string {
  const kind = step.toolKind?.toLowerCase();
  if (step.weight === 'command' || kind === 'execute' || kind === 'ran' || step.command) {
    return '>_';
  }
  if (step.weight === 'mutation' || ['edit', 'write', 'move', 'delete'].includes(kind ?? '')) {
    return '▧';
  }
  return '◇';
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

function presentedStepLabel(step: TurnActivityAction): string {
  const hint = step.command ?? step.input ?? step.files?.[0]?.path ?? step.toolKind;
  return hint ? `Used tool · ${hint}` : 'Used tool';
}

function LedgerStepRow({
  active,
  isLast,
  step,
}: {
  active: boolean;
  isLast: boolean;
  step: TurnActivityAction;
}) {
  const [expanded, setExpanded] = useState(false);
  const outcome = resolvedOutcome(step, active, isLast);
  const label = presentedStepLabel(step);
  const hasDetail = Boolean(step.command || step.input || step.output || step.files?.length);
  const accessibilityLabel = [
    label,
    outcome === 'failure' ? 'failed' : outcome === 'running' ? 'running' : 'succeeded',
    step.reason,
  ]
    .filter(Boolean)
    .join(', ');
  const details = [
    `Tool: ${step.title}`,
    `Result: ${step.status ?? outcome}`,
    ...(step.command ? [`Command:\n${step.command}`] : []),
    ...(step.input ? [`Arguments:\n${step.input}`] : []),
    ...(step.files ?? []).map((file) => `${file.status ? `${file.status} ` : ''}${file.path}`),
    ...(step.output ? [`Output:\n${step.output}`] : []),
    ...(step.reason ? [step.reason] : []),
    ...(step.requestedBy
      ? [`at ${step.requestedBy.name ?? step.requestedBy.pubkey.slice(0, 12)}'s request`]
      : []),
  ];
  const row = (
    <>
      <View style={styles.stepRow}>
        <Text accessibilityElementsHidden style={styles.stepGlyph}>
          {stepGlyph(step)}
        </Text>
        <Text numberOfLines={1} style={styles.stepLabel}>
          {label}
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
        {hasDetail ? (
          <Text accessibilityElementsHidden style={styles.disclosureGlyph}>
            {expanded ? '⌃' : '⌄'}
          </Text>
        ) : null}
      </View>
      {expanded && hasDetail ? (
        <ScrollView
          nestedScrollEnabled
          style={styles.stepDetails}
          testID={`corner-tool-row-detail-${step.id}`}
        >
          {details.map((detail, index) => (
            <Text key={`${step.id}:${index}`} style={styles.stepDetail}>
              {detail}
            </Text>
          ))}
        </ScrollView>
      ) : null}
    </>
  );
  if (!hasDetail) return <View testID={`corner-tool-row-${step.id}`}>{row}</View>;
  return (
    <Pressable
      accessibilityHint={expanded ? 'Collapses activity details' : 'Shows activity details'}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: outcome === 'running', expanded }}
      onPress={() => setExpanded((value) => !value)}
      style={styles.stepDisclosure}
      testID={`corner-tool-row-${step.id}`}
    >
      {row}
    </Pressable>
  );
}

function activitySummary(steps: readonly TurnActivityAction[], active: boolean): string {
  const count = steps.length;
  const failures = steps.filter((step) => step.outcome === 'failure').length;
  const head = `${count} TOOL ${count === 1 ? 'CALL' : 'CALLS'}`;
  if (failures) return `${head} · ${failures} FAILED`;
  return active ? `${head} · WORKING` : head;
}

/**
 * The live conversational turn. One compact mechanism row sits between prose
 * outputs; it expands on demand into the helper's bounded, redacted per-call
 * record. The selector removes it when the signed turn ends.
 */
export const ActivityTimeline = React.memo(function ActivityTimeline({
  active = false,
  handle,
  items,
  stamp,
  testID,
  messageDraft,
  mark,
}: ActivityTimelineProps) {
  const turn = useMemo(() => buildTurnActivity(items), [items]);
  const steps = turn.steps.filter((step) => step.kind === 'tool');
  const [expanded, setExpanded] = useState(false);
  // Settled turns keep their collapsed tool rows (#804); only an empty live
  // lane (no steps, no draft) renders nothing.
  if (!steps.length && !(active && messageDraft)) return null;

  return (
    <View style={styles.timeline} testID={testID}>
      {handle ? (
        <LedgerBylineView
          byline={{ name: handle, role: 'agent', stamp: stamp ?? '', mark }}
        />
      ) : null}
      {steps.length ? (
        <>
          <Pressable
            accessibilityHint={expanded ? 'Hides individual tool calls' : 'Shows individual tool calls'}
            accessibilityLabel={activitySummary(steps, active)}
            accessibilityRole="button"
            accessibilityState={{ busy: active, expanded }}
            onPress={() => setExpanded((value) => !value)}
            style={styles.summaryDisclosure}
            testID="corner-tool-summary"
          >
            <Text style={styles.summaryLabel}>{activitySummary(steps, active)}</Text>
            <Text accessibilityElementsHidden style={styles.disclosureGlyph}>{expanded ? '⌃' : '⌄'}</Text>
          </Pressable>
          {expanded
            ? steps.map((step, index) => (
                <LedgerStepRow active={active} isLast={index === steps.length - 1} key={step.id} step={step} />
              ))
            : null}
        </>
      ) : null}
      {messageDraft ? (
        <MonoMarkdown
          markdown={messageDraft}
          textStyle={styles.messageDraft}
          testID="activity-message-draft"
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    timeline: { width: '100%', minWidth: 0, paddingVertical: 4 },
    messageDraft: {
      ...Typography.ledger(),
      color: groknight.ledgerBright,
      fontSize: 16,
      lineHeight: 25,
      marginTop: 2,
    },
    stepDisclosure: {
      minWidth: 0,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: groknight.borderQuiet,
    },
    summaryDisclosure: {
      minHeight: 32,
      paddingHorizontal: 4,
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: groknight.borderQuiet,
    },
    summaryLabel: {
      ...Typography.mono('semiBold'),
      flex: 1,
      minWidth: 0,
      color: groknight.ledgerQuiet,
      fontSize: 11,
      lineHeight: 18,
    },
    stepRow: {
      minHeight: 36,
      minWidth: 0,
      paddingHorizontal: 4,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    stepGlyph: {
      ...Typography.mono(),
      width: 18,
      flexShrink: 0,
      color: groknight.ledgerGhost,
      fontSize: 10,
      lineHeight: 18,
    },
    stepLabel: {
      ...Typography.mono(),
      flex: 1,
      minWidth: 48,
      color: groknight.ledgerQuiet,
      fontSize: 11,
      lineHeight: 18,
    },
    verdict: {
      ...Typography.mono(),
      flexShrink: 0,
      color: groknight.ledgerGhost,
      fontSize: 11,
      lineHeight: 18,
    },
    verdictFailed: { color: groknight.accent },
    disclosureGlyph: {
      ...Typography.mono(),
      flexShrink: 0,
      color: groknight.ledgerGhost,
      fontSize: 10,
      lineHeight: 18,
    },
    runningMark: { flexShrink: 0, minWidth: 16, alignItems: 'center' },
    stepDetails: { maxHeight: 168, paddingHorizontal: 30, paddingBottom: 9 },
    stepDetail: {
      ...Typography.mono(),
      color: groknight.ledgerQuiet,
      fontSize: 10,
      lineHeight: 15,
      marginBottom: 2,
    },
  };
});
