import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { workflowDisplayName, workflowStateLabel } from '@/buzz/workflow-graph';
import { workflowRunStateWord } from '@/buzz/workflow-run-copy';
import { CORNER_META_SIZE } from './CornerGlyph';
import { WorkflowGlyph } from './WorkflowGlyph';

/**
 * What the corner was opened for, inscribed beneath the header for the corner's
 * whole life.
 *
 * The objective used to be a boxed OBJECTIVE panel, removed with the rest of
 * the header furniture in #844 on the grounds that the corner name was the
 * objective verbatim. Short corner names (#890) ended that: the header now
 * carries a slug, and the human's actual request survived only in the empty
 * state, so it vanished at the first message — exactly when the transcript
 * starts to bury what the work was for.
 *
 * So it comes back as prose, not as a panel: a brass `humanRail` hairline in
 * the margin, `textSecondary` copy at the prose margin, no border, no fill, no
 * label. The rail is the same mark the ledger gives a human's own words, which
 * is what this is — the person's request, held still while the agent works. A
 * box is for something the reader must act on (DESIGN.md), and this is only
 * ever a reminder.
 *
 * It wraps to its full height rather than truncating to a fragment, and renders
 * nothing at all when there is neither an objective nor a brief — never a
 * placeholder. The text is whatever `cornerObjectiveItems` has already
 * filtered; raw harness output never reaches this region.
 *
 * The objective is only a navigation label; the corner's brief carries the
 * authority. When the corner has one, a `Brief` link hangs in the right gutter
 * and opens its latest revision full-screen.
 *
 * When a workflow run is live in the corner, one more line sits under the
 * objective on the same rail: the workflow, its current step, and whose move
 * it is, with → to the run page. The corner never draws the graph itself.
 */
export const CornerObjectiveLine = React.memo(function CornerObjectiveLine({
  objective,
  onOpenBrief,
  workflow,
  onOpenWorkflow,
  testID = 'corner-objective-line',
}: {
  objective?: string;
  /** Present only when the corner has a brief. */
  onOpenBrief?: () => void;
  /** The corner's live workflow run, if any. */
  workflow?: WorkflowRunSummaryView;
  onOpenWorkflow?: () => void;
  testID?: string;
}) {
  const line = objective?.trim();
  const run = workflow?.status === 'live' && onOpenWorkflow ? workflow : undefined;
  if (!line && !onOpenBrief && !run) return null;
  return (
    <View style={styles.line} testID={testID}>
      <View style={styles.rail} />
      <View style={styles.inner}>
        {line || onOpenBrief ? (
          <View style={styles.objective}>
            <Text accessibilityRole="text" style={styles.copy} testID={`${testID}-copy`}>
              {line}
            </Text>
            {onOpenBrief ? (
              <CornerBriefLink onPress={onOpenBrief} testID={`${testID}-brief`} />
            ) : null}
          </View>
        ) : null}
        {run ? (
          <CornerWorkflowLine onPress={onOpenWorkflow!} run={run} testID={`${testID}-workflow`} />
        ) : null}
      </View>
    </View>
  );
});

/** `Feedback triage · Approve · waiting on you   →`, one tappable line. */
function CornerWorkflowLine({
  run,
  onPress,
  testID,
}: {
  run: WorkflowRunSummaryView;
  onPress: () => void;
  testID: string;
}) {
  const name = workflowDisplayName(run.workflowSlug);
  const step = workflowStateLabel(run.state);
  const state = workflowRunStateWord(run);
  return (
    <Pressable
      accessibilityLabel={`Open ${name} workflow, ${step}, ${state}`}
      accessibilityRole="link"
      hitSlop={WORKFLOW_HIT_SLOP}
      onPress={onPress}
      style={({ pressed }) => [styles.workflow, pressed && styles.briefLinkPressed]}
      testID={testID}
    >
      <WorkflowGlyph size={CORNER_META_SIZE} />
      <Text numberOfLines={1} style={styles.workflowCopy} testID={`${testID}-copy`}>
        {name} · <Text style={styles.workflowStep}>{step}</Text> ·{' '}
        <Text style={run.viewerHolds ? styles.workflowYou : undefined}>{state}</Text>
      </Text>
      <Text style={styles.workflowArrow}>→</Text>
    </Pressable>
  );
}

/** The line is one meta row tall; the slop makes its touch target 44pt. */
const WORKFLOW_HIT_SLOP = { top: 12, bottom: 12 };

/**
 * The corner brief's link: one brass word, a 44pt touch target whose extra
 * height hangs outside the line so the inscription keeps its quiet rhythm.
 * Shared by the phone's objective line and the desktop work pane.
 */
export function CornerBriefLink({
  onPress,
  testID = 'corner-brief-link',
}: {
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityLabel="Open brief"
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.briefLink, pressed && styles.briefLinkPressed]}
      testID={testID}
    >
      <Text style={styles.briefLinkText}>Brief</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  // No border, no fill, no radius: the rail is the whole frame this line gets.
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minWidth: 0,
    // The transcript's content inset, so the copy sits on the prose margin.
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 4,
    gap: 8,
  },
  rail: {
    alignSelf: 'stretch',
    width: 2,
    backgroundColor: theme.buzz.humanRail,
  },
  inner: { flex: 1, minWidth: 0 },
  objective: { flexDirection: 'row', alignItems: 'flex-start', minWidth: 0, gap: 8 },
  workflow: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    gap: 8,
    marginTop: 8,
  },
  workflowCopy: {
    ...theme.buzz.type.meta,
    flex: 1,
    minWidth: 0,
    color: theme.buzz.textSecondary,
  },
  workflowStep: { color: theme.buzz.textPrimary },
  workflowYou: { color: theme.buzz.accent },
  workflowArrow: {
    ...theme.buzz.type.meta,
    minWidth: 44,
    textAlign: 'right',
    color: theme.buzz.accent,
  },
  copy: {
    ...theme.buzz.type.meta,
    flex: 1,
    minWidth: 0,
    color: theme.buzz.textSecondary,
  },
  briefLink: {
    flexShrink: 0,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
    // Center the word on the first line of copy; the rest of the 44pt target
    // overhangs the line instead of pushing the transcript down.
    marginVertical: -(44 - theme.buzz.type.meta.lineHeight) / 2,
  },
  briefLinkPressed: { opacity: 0.6 },
  briefLinkText: {
    ...theme.buzz.type.meta,
    color: theme.buzz.accent,
  },
}));
