import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentActivityItem } from '@/sync/transport/rig-transport';
import { buildTurnActivity, type TurnActivityAction } from '@/buzz/activity-timeline';
import { Typography } from '@/constants/Typography';
import { PixelLoader } from './MonoHull';
import { MonoMarkdown } from './MonoMarkdown';

type ActivityTimelineProps = {
  active?: boolean;
  items: readonly AgentActivityItem[];
  handle?: string;
  stamp?: string;
  testID?: string;
  thought?: string;
  messageDraft?: string;
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

function LedgerStepRow({
  active,
  isLast,
  step,
}: {
  active: boolean;
  isLast: boolean;
  step: TurnActivityAction;
}) {
  const outcome = resolvedOutcome(step, active, isLast);
  const accessibilityLabel = [
    step.label,
    outcome === 'failure' ? 'failed' : outcome === 'running' ? 'running' : 'succeeded',
    step.reason,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: outcome === 'running' }}
      style={styles.stepRow}
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
    </View>
  );
}

/**
 * The live three-lane turn. Thought replaces in place, tool calls are one
 * non-interactive mono row each, and the answer accumulates beneath them.
 * The selector removes this whole component the instant the signed turn ends.
 */
export const ActivityTimeline = React.memo(function ActivityTimeline({
  active = false,
  handle,
  items,
  stamp,
  testID,
  thought,
  messageDraft,
}: ActivityTimelineProps) {
  const turn = useMemo(() => buildTurnActivity(items), [items]);
  const steps = turn.steps.filter((step) => step.kind === 'tool');
  if (!active || (!thought && !messageDraft && !steps.length)) return null;

  return (
    <View style={styles.timeline} testID={testID}>
      {handle ? (
        <View style={styles.liveByline}>
          <Text style={styles.liveBylineName}>{handle.toUpperCase()}</Text>
          <Text style={styles.liveBylineRole}> · agent</Text>
          {stamp ? <Text style={styles.liveStamp}>{stamp}</Text> : null}
        </View>
      ) : null}
      {thought ? (
        <View style={styles.thoughtLane} testID="activity-thought-lane">
          <View style={styles.thoughtLabel}>
            <PixelLoader compact />
            <Text style={styles.thoughtEyebrow}>THINKING</Text>
          </View>
          <Text style={styles.thoughtText}>{thought}</Text>
        </View>
      ) : null}
      {steps.map((step, index) => (
        <LedgerStepRow active isLast={index === steps.length - 1} key={step.id} step={step} />
      ))}
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
    liveByline: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 8 },
    liveBylineName: {
      ...Typography.mono('semiBold'),
      color: groknight.accent,
      fontSize: 11,
      letterSpacing: 0.5,
    },
    liveBylineRole: { ...Typography.mono(), color: groknight.ledgerGhost, fontSize: 11 },
    liveStamp: {
      ...Typography.mono(),
      marginLeft: 'auto',
      color: groknight.ledgerGhost,
      fontSize: 10,
    },
    thoughtLane: {
      borderLeftWidth: 2,
      borderLeftColor: groknight.borderQuiet,
      paddingLeft: 13,
      paddingVertical: 2,
      marginBottom: 6,
      gap: 4,
    },
    thoughtLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    thoughtEyebrow: {
      ...Typography.mono(),
      color: groknight.ledgerGhost,
      fontSize: 9,
      letterSpacing: 1.2,
    },
    thoughtText: {
      ...Typography.default(),
      color: groknight.ledgerQuiet,
      fontSize: 13,
      fontStyle: 'italic',
      lineHeight: 19,
    },
    messageDraft: {
      ...Typography.ledger(),
      color: groknight.ledgerBright,
      fontSize: 16,
      lineHeight: 25,
      marginTop: 8,
    },
    stepRow: {
      minHeight: 36,
      minWidth: 0,
      paddingHorizontal: 4,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: groknight.borderQuiet,
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
    runningMark: { flexShrink: 0, minWidth: 16, alignItems: 'center' },
    stepReason: {
      ...Typography.mono(),
      flexShrink: 1,
      minWidth: 0,
      color: groknight.ledgerQuiet,
      fontSize: 10,
      lineHeight: 18,
    },
  };
});
