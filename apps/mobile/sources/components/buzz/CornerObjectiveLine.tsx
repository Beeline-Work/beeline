import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { workflowStateLabel } from '@/buzz/workflow-graph';
import { CORNER_META_SIZE } from './CornerGlyph';
import { WorkflowGlyph } from './WorkflowGlyph';

/** The corner objective sits above the compact workflow and brief actions. */
export const CornerObjectiveLine = React.memo(function CornerObjectiveLine({
  objective,
  onOpenBrief,
  workflow,
  onOpenWorkflow,
  workflowError,
  onRetryWorkflow,
  testID = 'corner-objective-line',
}: {
  objective?: string;
  /** Present only when the corner has a brief. */
  onOpenBrief?: () => void;
  /** The corner's live workflow run, if any. */
  workflow?: WorkflowRunSummaryView;
  onOpenWorkflow?: () => void;
  workflowError?: string | null;
  onRetryWorkflow?: () => void;
  testID?: string;
}) {
  const line = objective?.trim();
  const run = workflow?.status === 'live' && onOpenWorkflow ? workflow : undefined;
  if (!line && !onOpenBrief && !run && !workflowError) return null;
  return (
    <View style={styles.line} testID={testID}>
      <View style={styles.rail} />
      <View style={styles.inner}>
        {line ? (
          <View style={styles.objective}>
            <Text accessibilityRole="text" style={styles.copy} testID={`${testID}-copy`}>
              {line}
            </Text>
          </View>
        ) : null}
        {workflowError ? (
          <View testID={`${testID}-workflow-error`}>
            <Text accessibilityRole="alert" style={styles.copy}>{workflowError}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Retry workflow" onPress={onRetryWorkflow} style={styles.briefLink} testID={`${testID}-workflow-retry`}>
              <Text style={styles.briefLinkText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
        {run || onOpenBrief ? (
          <View style={styles.links}>
            {run ? (
              <CornerWorkflowLine onPress={onOpenWorkflow!} run={run} testID={`${testID}-workflow`} />
            ) : null}
            {onOpenBrief ? (
              <CornerBriefLink onPress={onOpenBrief} testID={`${testID}-brief`} />
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
});

/** Compact workflow link beside the brief action. */
function CornerWorkflowLine({
  run,
  onPress,
  testID,
}: {
  run: WorkflowRunSummaryView;
  onPress: () => void;
  testID: string;
}) {
  const step = workflowStateLabel(run.state);
  return (
    <Pressable
      accessibilityLabel={`Open workflow, ${step}`}
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.workflow, pressed && styles.briefLinkPressed]}
      testID={testID}
    >
      <WorkflowGlyph size={CORNER_META_SIZE} />
      <Text numberOfLines={1} style={styles.workflowCopy} testID={`${testID}-copy`}>
        {step}
      </Text>
    </Pressable>
  );
}

/** Full brief link shared by the phone and desktop work pane. */
export function CornerBriefLink({
  onPress,
  testID = 'corner-brief-link',
}: {
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityLabel="Read brief"
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.briefLink, pressed && styles.briefLinkPressed]}
      testID={testID}
    >
      <Text style={styles.briefLinkText}>Read brief</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The rail is the frame for this persistent corner context.
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minWidth: 0,
    // Align the text with the transcript's prose margin.
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
  links: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 12 },
  workflow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    gap: 8,
  },
  workflowCopy: {
    ...theme.buzz.type.meta,
    color: theme.buzz.textSecondary,
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
  },
  briefLinkPressed: { opacity: 0.6 },
  briefLinkText: {
    ...theme.buzz.type.meta,
    color: theme.buzz.accent,
  },
}));
