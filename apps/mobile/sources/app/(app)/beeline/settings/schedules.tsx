import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import { Button } from '@/components/buzz/Button';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { cornerShortTitle, roomTitle, type RoomScheduleView, type RoomSubscriptionView } from '@beeline/api-contract/phone';
import {
  scheduleTitle,
  scheduleTrigger,
  subscriptionTitle,
  subscriptionWhen,
  scheduleWhere,
  useScheduledWork,
} from '@/buzz/scheduled-work';
import { PageHeader } from '@/components/buzz/PageHeader';
import { ScheduledWorkWhere } from '@/components/buzz/ScheduledWorkWhere';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

type WorkEntry =
  | { kind: 'schedule'; value: RoomScheduleView }
  | { kind: 'subscription'; value: RoomSubscriptionView };

/** Timers by next run across all call sites, then event triggers. */
export function orderScheduledWork(
  schedules: readonly RoomScheduleView[],
  subscriptions: readonly RoomSubscriptionView[],
): WorkEntry[] {
  return [
    ...schedules.map((value): WorkEntry => ({ kind: 'schedule', value })),
    ...subscriptions.map((value): WorkEntry => ({ kind: 'subscription', value })),
  ].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'schedule' ? -1 : 1;
    if (a.kind === 'schedule' && b.kind === 'schedule') return a.value.nextRunAt - b.value.nextRunAt;
    return 0;
  });
}

function ListAttribution({ agent, corner, roomName, isDirectMessage }: {
  isDirectMessage?: boolean;
  roomName?: string | null;
  agent: string;
  corner?: { id: string; name: string } | null;
}) {
  return <>
    <Text numberOfLines={1} style={styles.listAgent}>@{agent}</Text>
    <Text style={styles.listDot}>{' · '}</Text>
    <ScheduledWorkWhere isDirectMessage={isDirectMessage} corner={corner ? { ...corner, name: cornerShortTitle(roomName, corner.name, corner.id) } : undefined} />
  </>;
}

/**
 * Everything that wakes the Room's agents without a human tag: timers and
 * subscriptions. Agents set both up. Timers order by next run before subscriptions.
 * Each row names the work, trigger, agent and call site, and opens its detail page.
 */
export default function ScheduledWork() {
  useLatencyRouteFrame('/beeline/settings/schedules');
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    roomId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const roomId = first(params.roomId);
  const workspaceId = first(params.workspaceId);
  const { work, loading, error, retry } = useScheduledWork(
    roomId && workspaceId ? roomId : undefined,
  );
  useLatencyRouteFrame('/beeline/settings/schedules', !loading, true);
  const schedules = work?.schedules ?? [];
  const subscriptions = work?.subscriptions ?? [];
  const entries = orderScheduledWork(schedules, subscriptions);

  const openSchedule = (schedule: RoomScheduleView) =>
    router.push({ pathname: '/beeline/settings/schedule', params: { roomId: roomId!, scheduleId: schedule.id } });

  const renderSchedule = (schedule: RoomScheduleView) => (
    <SettingsRow
      chevron="right"
      description={scheduleTrigger(schedule)}
      descriptionContent={<Text numberOfLines={1} style={styles.listTrigger}>{scheduleTrigger(schedule)}</Text>}
      descriptionDetail={`@${work?.agentNames.get(schedule.agentId) ?? 'Agent'} · ${scheduleWhere(schedule, work?.roomName, work?.isDirectMessage)}`}
      descriptionDetailContent={<ListAttribution
        isDirectMessage={work?.isDirectMessage} roomName={work?.roomName} agent={work?.agentNames.get(schedule.agentId) ?? 'Agent'} corner={schedule.corner} />}
      key={schedule.id}
      onPress={() => openSchedule(schedule)}
      testID={`scheduled-work-${schedule.id}`}
      title={scheduleTitle(schedule)}
    />
  );

  const renderSubscription = (subscription: RoomSubscriptionView) => (
    <SettingsRow
      chevron="right"
      description={subscriptionWhen(subscription, work?.isDirectMessage)}
      descriptionContent={<Text numberOfLines={1} style={styles.listTrigger}>{subscriptionWhen(subscription, work?.isDirectMessage)}</Text>}
      descriptionDetail={`@${work?.agentNames.get(subscription.agentId) ?? 'Agent'} · ${scheduleWhere(subscription, work?.roomName, work?.isDirectMessage)}`}
      descriptionDetailContent={<ListAttribution
        isDirectMessage={work?.isDirectMessage} roomName={work?.roomName} agent={work?.agentNames.get(subscription.agentId) ?? 'Agent'} corner={subscription.corner} />}
      key={subscription.id}
      onPress={() =>
        router.push({
          pathname: '/beeline/settings/subscription',
          params: { roomId: roomId!, subscriptionId: subscription.id },
        })
      }
      testID={`subscription-${subscription.id}`}
      title={subscriptionTitle(subscription)}
    />
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <PageHeader
        backAccessibilityLabel={work?.isDirectMessage ? 'Back to DM' : 'Back to Room'}
        eyebrow={work?.isDirectMessage ? 'DM' : roomTitle(work?.roomName) ?? 'Room'}
        onBack={() => router.back()}
        testID="scheduled-work-header"
        title="Schedules and subscriptions"
      />
      {error && <ErrorBanner title={error} retryLabel="Retry" onRetry={retry}
          />}
      {loading ? (
        <View style={styles.loading}>
          <SurfaceGlyphLoader testID="schedules-loader" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
          keyboardShouldPersistTaps="handled"
          testID="scheduled-work-list"
        >
          {entries.length === 0 ? (
            <View style={styles.emptyBlock} testID="scheduled-work-empty">
              <Ionicons color={styles.emptyIcon.color} name="time-outline" size={22} />
              <Text style={styles.emptyTitle}>Nothing wakes agents here yet</Text>
              <Text style={styles.empty}>
                Agents set up schedules and subscriptions. Ask an agent in {work?.isDirectMessage ? 'this DM' : 'this Room'} to add one.
              </Text>
            </View>
          ) : (
            <View style={styles.rows}>{entries.map((entry) => entry.kind === 'schedule'
            ? renderSchedule(entry.value) : renderSubscription(entry.value))}</View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  loading: { padding: theme.buzz.space.xl, alignItems: 'center', justifyContent: 'center' },
  // SettingsRow pads by `space.sm`; keep the flat list on the 16pt page axis.
  rows: { paddingHorizontal: theme.buzz.space.sm },
  listTrigger: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary, flexShrink: 1 },
  listDot: { ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  listAgent: { ...theme.buzz.type.meta, color: theme.buzz.textMuted, flexShrink: 1, minWidth: 0 },
  emptyBlock: { padding: theme.buzz.space.xl, alignItems: 'flex-start', justifyContent: 'center' },
  emptyIcon: { color: theme.buzz.accent },
  emptyTitle: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary, marginTop: theme.buzz.space.sm },
  empty: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary, marginTop: theme.buzz.space.sm },
  error: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    backgroundColor: theme.buzz.bgHighlight,
  },
  errorText: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
}));
