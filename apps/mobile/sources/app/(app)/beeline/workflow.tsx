import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { workflowRunHref } from '@/buzz/workflow-run-copy';
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { workflowDisplayName } from '@/buzz/workflow-graph';
import { workflowStarterLine } from '@/buzz/workflow-run-copy';
import { scheduleRuns, scheduleWhere, stopSchedule, stopSubscription,
  subscriptionRuns, subscriptionWhere, useScheduledWork } from '@/buzz/scheduled-work';
import { PageHeader } from '@/components/buzz/PageHeader';
import { DetailSection, ScheduledWorkFacts, StopScheduledWork } from '@/components/buzz/ScheduledWorkDetail';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { WorkflowRunLine } from '@/components/buzz/WorkflowRunLine';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/**
 * One workflow: its steps on the run page's rail (every step pending, as no
 * run is open here) and its runs, reached from a run's "All runs" link or
 * from scheduled work. Opened from a schedule or subscription listed under
 * `parentRoomId`, it shows that trigger's When, Agent and Where rows and Stop.
 */
export default function Workflow() {
  useLatencyRouteFrame('/beeline/workflow');
  const params = useLocalSearchParams<{
    roomId: string;
    name: string;
    scheduleId?: string;
    subscriptionId?: string;
    parentRoomId?: string;
  }>();
  const roomId = Array.isArray(params.roomId) ? params.roomId[0] : params.roomId;
  const name = Array.isArray(params.name) ? params.name[0] : params.name;
  const scheduleId = Array.isArray(params.scheduleId) ? params.scheduleId[0] : params.scheduleId;
  const subscriptionId = Array.isArray(params.subscriptionId) ? params.subscriptionId[0] : params.subscriptionId;
  const parentRoomId = Array.isArray(params.parentRoomId)
    ? params.parentRoomId[0]
    : params.parentRoomId;
  const insets = useSafeAreaInsets();
  const [detail, setDetail] = useState<
    PhoneOperationMap['readWorkflowDefinition']['output'] | null
  >(null);
  useLatencyRouteFrame('/beeline/workflow', detail !== null, true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setDetail(await monolithPhoneOperation('readWorkflowDefinition', { roomId, name }));
      setError(null);
    } catch (caught) {
      setError(String(caught));
    }
  }, [roomId, name]);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  const scheduled = useScheduledWork(scheduleId || subscriptionId ? parentRoomId : undefined);
  const schedule = scheduled.work?.schedules.find((candidate) => candidate.id === scheduleId);
  const subscription = scheduled.work?.subscriptions.find((candidate) => candidate.id === subscriptionId);
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    if (!parentRoomId || (!schedule && !subscription)) return;
    setStopping(true);
    try {
      if (schedule) await stopSchedule(parentRoomId, schedule.id);
      else if (subscription) await stopSubscription(parentRoomId, subscription.id);
      router.back();
    } catch (caught) {
      setError(`Could not stop the ${schedule ? 'schedule' : 'subscription'}: ${String(caught)}`);
    } finally {
      setStopping(false);
    }
  };
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <PageHeader
        title={workflowDisplayName(name)}
        onBack={() => router.back()}
        backAccessibilityLabel="Back"
        testID="workflow-header"
      />
      {error ? (
        <Pressable onPress={() => void reload()}>
          <Text accessibilityRole="alert" style={styles.error}>
            {error} · Retry
          </Text>
        </Pressable>
      ) : null}
      {(scheduleId || subscriptionId) && scheduled.error ? (
        <Pressable onPress={scheduled.retry}
          testID={scheduleId ? 'workflow-schedule-error' : 'workflow-subscription-error'}>
          <Text accessibilityRole="alert" style={styles.error}>
            {scheduled.error} · Retry
          </Text>
        </Pressable>
      ) : null}
      {!detail && !error ? <SurfaceGlyphLoader /> : null}
      {detail ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}>
          <Text style={styles.description}>
            {detail.contract.summary ?? detail.contract.description}
          </Text>
          {schedule ? (
            <ScheduledWorkFacts
              agents={[scheduled.work?.agentNames.get(schedule.agentId) ?? 'Agent']}
              runs={scheduleRuns(schedule)}
              where={scheduleWhere(schedule, scheduled.work?.roomName)}
              whereCorner={schedule.corner}
            />
          ) : subscription ? (
            <ScheduledWorkFacts
              agents={[scheduled.work?.agentNames.get(subscription.agentId) ?? 'Agent']}
              runs={subscriptionRuns(subscription)}
              where={subscriptionWhere(subscription, scheduled.work?.roomName)}
              whereCorner={subscription.corner}
            />
          ) : null}
          <DetailSection testID="workflow-steps-header" title="Steps" />
          <WorkflowRunLine
            detail={{ contract: detail.contract, roleHolders: {} }}
            now={0}
            onOpenCorner={() => undefined}
            testID="workflow-steps"
          />
          <Text style={styles.heading}>History</Text>
          {detail.runs.map((run) => (
            <Pressable
              key={run.runId}
              accessibilityRole="button"
              style={styles.run}
              onPress={() =>
                router.push(workflowRunHref(run))
              }
            >
              <Text style={styles.title}>
                {run.status === 'live' ? 'Running' : run.status === 'done' ? 'Completed' : run.status === 'abandoned' ? 'Abandoned' : 'Failed'}
              </Text>
              <Text style={styles.meta}>{workflowStarterLine(run)}</Text>
              <Text selectable style={styles.id}>
                {run.runId}
              </Text>
            </Pressable>
          ))}
          {!detail.runs.length ? <Text style={styles.description}>No runs yet.</Text> : null}
          {schedule || subscription ? (
            <StopScheduledWork
              label={schedule ? 'Stop schedule' : 'Stop subscription'}
              onStop={() => void stop()}
              testID={schedule ? 'stop-workflow-schedule' : 'stop-workflow-subscription'}
              working={stopping}
            />
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  description: {
    ...theme.buzz.type.body,
    color: theme.buzz.textSecondary,
    padding: theme.buzz.space.md,
  },
  heading: {
    ...theme.buzz.type.sectionHead,
    color: theme.buzz.ledgerQuiet,
    padding: theme.buzz.space.md,
  },
  run: {
    padding: theme.buzz.space.md,
    gap: theme.buzz.space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.buzz.border,
  },
  title: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  meta: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
  id: { ...theme.buzz.type.machine, color: theme.buzz.textSecondary },
  error: { ...theme.buzz.type.meta, color: theme.buzz.danger, padding: theme.buzz.space.md },
}));
