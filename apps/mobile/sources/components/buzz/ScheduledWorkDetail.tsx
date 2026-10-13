import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { HullDialogActions } from './HullDialog';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { workflowDisplayName } from '@/buzz/workflow-graph';
import { SettingsRow } from './SettingsRow';
import { ScheduledWorkWhere } from './ScheduledWorkWhere';

/**
 * The parts a schedule's or subscription's own page is built from, cut from the
 * workflow run page (`workflow-run.tsx`) so the three read as one family: its
 * hairline section head, its summary rail line, and the settings rows every
 * trigger detail page shares — When, Agent, Where, Does, then Stop.
 */
export function DetailSection({ title, testID }: { title: string; testID?: string }) {
  return (
    <View style={styles.section} testID={testID}>
      <RoomListSectionHeader title={title} inset="content" spacing="flush"/>
    </View>
  );
}

/** The run page's summary line: a human rail beside quiet copy. */
export function DetailRailLine({ children, testID }: { children: React.ReactNode; testID?: string }) {
  return (
    <View style={styles.summaryLine}>
      <View style={styles.summaryRail} />
      <Text selectable style={styles.summary} testID={testID}>
        {children}
      </Text>
    </View>
  );
}

/** When, Agent or Agents, and Where: the same three rows on every detail page. */
export function ScheduledWorkFacts({
  runs,
  agents,
  where,
  whereCorner,
  testID = 'scheduled-work-facts',
}: {
  runs: string;
  agents: readonly string[];
  where: string;
  whereCorner?: { id: string; name: string } | null;
  testID?: string;
}) {
  return (
    <View style={styles.facts} testID={testID}>
      <SettingsRow description={runs} testID={`${testID}-when`} title="When" />
      <SettingsRow
        description={agents.length ? agents.map((name) => `@${name}`).join(', ') : 'None'}
        testID={`${testID}-agents`}
        title={agents.length > 1 ? 'Agents' : 'Agent'}
      />
      <SettingsRow description={where}
        descriptionContent={whereCorner ? <ScheduledWorkWhere corner={whereCorner} /> : undefined}
        testID={`${testID}-where`} title="Where" />
    </View>
  );
}

/** The same action rail for timer and event triggers. */
export function ScheduledWorkDoes({ roomId, prompt, workflowSlug }: {
  roomId: string;
  prompt: string;
  workflowSlug?: string;
}) {
  return (
    <>
      <DetailSection title="Does" testID="scheduled-work-does-header" />
      {workflowSlug ? (
        <>
          <View style={styles.facts}>
            <SettingsRow
              chevron="right"
              description="Workflow"
              onPress={() => router.push({ pathname: '/beeline/workflow', params: { roomId, name: workflowSlug } })}
              testID="scheduled-work-workflow"
              title={workflowDisplayName(workflowSlug)}
            />
          </View>
        </>
      ) : (
        <DetailRailLine testID="scheduled-work-prompt">{prompt}</DetailRailLine>
      )}
    </>
  );
}

/**
 * "Stop schedule" or "Stop subscription": one tap asks, a second confirms, the
 * same two steps the schedule list's STOP took.
 */
export function StopScheduledWork({
  label,
  onStop,
  working,
  testID,
}: {
  label: string;
  onStop: () => void;
  working: boolean;
  testID: string;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <View style={styles.facts}>
      {confirming ? (
        <HullDialogActions
          actions={[
            {
              label: 'Cancel',
              disabled: working,
              onPress: () => setConfirming(false),
              testID: `${testID}-cancel`,
            },
            {
              label,
              variant: 'destructive',
              disabled: working,
              onPress: onStop,
              testID: `${testID}-confirm`,
            },
          ]}
        />
      ) : (
        <SettingsRow
          disabled={working}
          onPress={() => setConfirming(true)}
          testID={testID}
          title={label}
          tone="destructive"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    minHeight: 32,
    marginTop: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.space.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  summaryLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginHorizontal: theme.buzz.space.md,
    marginVertical: theme.buzz.space.md,
  },
  summaryRail: {
    position: 'absolute', left: -theme.buzz.space.sm, top: 0, bottom: 0,
    width: 2, backgroundColor: theme.buzz.humanRail,
  },
  summary: {
    ...theme.buzz.type.meta,
    flex: 1,
    minWidth: 0,
    color: theme.buzz.textSecondary,
  },
  // SettingsRow pads by `space.sm`; the page's copy sits at `space.md`.
  facts: { paddingHorizontal: theme.buzz.space.sm },
}));
