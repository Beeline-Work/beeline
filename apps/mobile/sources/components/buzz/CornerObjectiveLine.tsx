import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { workflowDisplayName, workflowStateLabel } from '@/buzz/workflow-graph';
import { CORNER_META_SIZE } from './CornerGlyph';
import { WorkflowGlyph } from './WorkflowGlyph';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';

/** `Related market arbitrage paper · Verify`: which run, and where it stands. */
function runLabel(run: WorkflowRunSummaryView): string {
  return `${workflowDisplayName(run.workflowSlug)} · ${workflowStateLabel(run.state)}`;
}

/** The corner objective sits above the compact workflow and brief actions. */
export const CornerObjectiveLine = React.memo(function CornerObjectiveLine({
  objective,
  onOpenBrief,
  workflow,
  onOpenWorkflow,
  otherLiveRuns = [],
  workflowError,
  onRetryWorkflow,
  testID = 'corner-objective-line',
}: {
  objective?: string;
  /** Present only when the corner has a brief. */
  onOpenBrief?: () => void;
  /** The corner's live workflow run, if any. */
  workflow?: WorkflowRunSummaryView;
  onOpenWorkflow?: (run: WorkflowRunSummaryView) => void;
  /** Every other live saved-workflow run in the corner, any workflow, beside the one named above. */
  otherLiveRuns?: readonly WorkflowRunSummaryView[];
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
              <WorkflowLine onPress={() => onOpenWorkflow!(run)} run={run} testID={`${testID}-workflow`} />
            ) : null}
            {run && otherLiveRuns.length > 0 ? (
              <OtherWorkflowRuns runs={otherLiveRuns} onOpenWorkflow={onOpenWorkflow!} testID={testID} />
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

function OtherWorkflowRuns({ runs, onOpenWorkflow, testID }: {
  runs: readonly WorkflowRunSummaryView[];
  onOpenWorkflow: (run: WorkflowRunSummaryView) => void;
  testID: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Pressable
        accessibilityLabel={`Show ${runs.length} other running workflows`}
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.briefLink, pressed && styles.briefLinkPressed]}
        testID={`${testID}-workflow-more`}
      >
        <Text style={styles.briefLinkText}>{`+${runs.length} running`}</Text>
      </Pressable>
      <HullActionSheetModal
        accessibilityLabel="Close running workflows"
        onClose={() => setOpen(false)}
        title="Other running workflows"
        testID={`${testID}-workflow-list`}
        visible={open}
        footer={<HullActionSheetCancel onPress={() => setOpen(false)} testID={`${testID}-workflow-list-close`} />}
      >
        {runs.map((run) => (
          <HullActionSheetRow
            key={run.runId}
            label={runLabel(run)}
            accessibilityLabel={`Open workflow, ${runLabel(run)}`}
            chevron="right"
            onPress={() => {
              setOpen(false);
              onOpenWorkflow(run);
            }}
            testID={`${testID}-workflow-other-${run.runId}`}
          />
        ))}
      </HullActionSheetModal>
    </>
  );
}

/** Compact workflow link beside the brief action. */
function WorkflowLine({
  run,
  onPress,
  testID,
}: {
  run: WorkflowRunSummaryView;
  onPress: () => void;
  testID: string;
}) {
  const label = runLabel(run);
  return (
    <Pressable
      accessibilityLabel={`Open workflow, ${label}`}
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.workflow, pressed && styles.briefLinkPressed]}
      testID={testID}
    >
      <WorkflowGlyph size={CORNER_META_SIZE} />
      <Text numberOfLines={1} style={styles.workflowCopy} testID={`${testID}-copy`}>
        {label}
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
    paddingHorizontal: 16,
    paddingTop: 8,
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
  links: { flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap', columnGap: 8 },
  workflow: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '100%',
    flexShrink: 1,
    minWidth: 0,
    minHeight: 44,
    gap: 8,
  },
  workflowCopy: {
    ...theme.buzz.type.meta,
    flexShrink: 1,
    minWidth: 0,
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
