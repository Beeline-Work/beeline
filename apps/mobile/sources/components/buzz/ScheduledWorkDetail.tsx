import React, { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { StyleSheet } from 'react-native-unistyles';
import { workflowDisplayName } from '@/buzz/workflow-graph';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { SettingsRow } from './SettingsRow';
import { WorkflowRunLine } from './WorkflowRunLine';
import { ScheduledWorkWhere } from './ScheduledWorkWhere';

/**
 * The parts a schedule's or subscription's own page is built from, cut from the
 * workflow run page (`workflow-run.tsx`) so the three read as one family: its
 * hairline section head (as "Steps" is drawn), its summary rail line, and the
 * settings rows every detail page shares — When, Agent, Where, Does, then Stop.
 */
export function DetailSection({ title, testID }: { title: string; testID?: string }) {
  return (
    <View style={styles.section} testID={testID}>
      <Text style={styles.sectionHead}>{title}</Text>
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

/** Plain copy under a section head, at the summary line's size. */
export function DetailCopy({ children, testID }: { children: React.ReactNode; testID?: string }) {
  return (
    <Text style={styles.copy} testID={testID}>
      {children}
    </Text>
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
export function ScheduledWorkDoes({ roomId, parentRoomId, scheduleId, subscriptionId, prompt, workflowSlug }: {
  roomId: string;
  parentRoomId?: string;
  scheduleId?: string;
  subscriptionId?: string;
  prompt: string;
  workflowSlug?: string;
}) {
  const [contract, setContract] = useState<PhoneOperationMap['readWorkflowDefinition']['output']['contract'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(useCallback(() => {
    if (!workflowSlug) return;
    let active = true;
    setContract(null);
    setError(null);
    void monolithPhoneOperation('readWorkflowDefinition', { roomId, name: workflowSlug })
      .then((result) => { if (active) setContract(result.contract); })
      .catch((caught) => { if (active) setError(String(caught)); });
    return () => { active = false; };
  }, [roomId, workflowSlug]));
  return (
    <>
      <DetailSection title="Does" testID="scheduled-work-does-header" />
      {workflowSlug ? (
        <>
          <View style={styles.facts}>
            <SettingsRow
              chevron="right"
              description="Workflow"
              onPress={() => router.push({ pathname: '/beeline/workflow', params: {
                roomId, name: workflowSlug,
                ...(parentRoomId ? { parentRoomId } : {}),
                ...(scheduleId ? { scheduleId } : {}),
                ...(subscriptionId ? { subscriptionId } : {}),
              } })}
              testID="scheduled-work-workflow"
              title={workflowDisplayName(workflowSlug)}
            />
          </View>
          {contract ? <View style={styles.workflowLine}>
            <WorkflowRunLine detail={{ contract, roleHolders: {} }} now={0}
              onOpenCorner={() => undefined} testID="scheduled-work-steps" />
          </View> : null}
          {error ? <DetailCopy testID="scheduled-work-workflow-error">Could not load workflow steps: {error}</DetailCopy> : null}
        </>
      ) : <DetailRailLine testID="scheduled-work-prompt">{prompt}</DetailRailLine>}
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
        <>
          <SettingsRow
            disabled={working}
            onPress={onStop}
            testID={`${testID}-confirm`}
            title={`Confirm: ${label}`}
            tone="destructive"
          />
          <SettingsRow
            disabled={working}
            onPress={() => setConfirming(false)}
            testID={`${testID}-cancel`}
            title="Cancel"
            tone="quiet"
          />
        </>
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
  sectionHead: { ...theme.buzz.type.sectionHead, color: theme.buzz.ledgerQuiet },
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
  copy: {
    ...theme.buzz.type.meta,
    color: theme.buzz.textSecondary,
    marginHorizontal: theme.buzz.space.md,
    marginTop: theme.buzz.space.md,
  },
  // SettingsRow pads by `space.sm`; the page's copy sits at `space.md`.
  facts: { paddingHorizontal: theme.buzz.space.sm },
  // The workflow circle starts at x=18 on its own page. Bring its left edge to the 16pt detail axis.
  workflowLine: { position: 'relative', left: -theme.buzz.space.xs / 2 },
}));
