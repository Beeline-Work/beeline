import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomScheduleView, RoomSubscriptionView } from '@beeline/api-contract/phone';
import { displayRoomIndexTitle } from '@/buzz/room-list-row';
import { scheduleCadenceLabel } from '@/buzz/schedule-cadence';
import {
  scheduleTitle,
  scheduleWhere,
  subscriptionTitle,
  subscriptionWhen,
  subscriptionWhere,
  useScheduledWork,
} from '@/buzz/scheduled-work';
import { CORNER_META_SIZE } from '@/components/buzz/CornerGlyph';
import { PageHeader } from '@/components/buzz/PageHeader';
import { ScheduledWorkWhere } from '@/components/buzz/ScheduledWorkWhere';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { WorkflowGlyph } from '@/components/buzz/WorkflowGlyph';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

type WorkEntry =
  | { kind: 'schedule'; value: RoomScheduleView }
  | { kind: 'subscription'; value: RoomSubscriptionView };

/** This Room, then each child corner; timers by next run before event triggers. */
export function orderScheduledWork(
  schedules: readonly RoomScheduleView[],
  subscriptions: readonly RoomSubscriptionView[],
): WorkEntry[] {
  return [
    ...schedules.map((value): WorkEntry => ({ kind: 'schedule', value })),
    ...subscriptions.map((value): WorkEntry => ({ kind: 'subscription', value })),
  ].sort((a, b) => {
    const aCorner = a.value.corner;
    const bCorner = b.value.corner;
    if (!aCorner || !bCorner) {
      if (aCorner) return 1;
      if (bCorner) return -1;
    } else {
      const cornerOrder = aCorner.name.localeCompare(bCorner.name) || aCorner.id.localeCompare(bCorner.id);
      if (cornerOrder) return cornerOrder;
    }
    if (a.kind !== b.kind) return a.kind === 'schedule' ? -1 : 1;
    if (a.kind === 'schedule' && b.kind === 'schedule') return a.value.nextRunAt - b.value.nextRunAt;
    return 0;
  });
}

function ListTail({ agent, corner, compact }: {
  agent: string;
  corner?: { id: string; name: string } | null;
  compact: boolean;
}) {
  const shownAgent = compact ? Array.from(agent)[0] ?? agent : agent;
  return <View style={styles.listTail}>
    <Text style={styles.listDot}>{'\u2009·\u2009'}</Text>
    <Text numberOfLines={1} style={styles.listAgent}>@{shownAgent}</Text>
    <Text style={styles.listDot}>{'\u2009·\u2009'}</Text>
    <ScheduledWorkWhere corner={corner} />
  </View>;
}

/**
 * Everything that wakes the Room's agents without a human tag: timers and
 * subscriptions. Agents set both up. A flat list orders this Room before its
 * corners, schedules by next run before subscriptions. Each row says what,
 * then when · who · where, and opens its own detail page.
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
      description={`· @${work?.agentNames.get(schedule.agentId) ?? 'Agent'} · ${scheduleWhere(schedule)}`}
      descriptionContent={<ListTail agent={work?.agentNames.get(schedule.agentId) ?? 'Agent'}
        compact={scheduleCadenceLabel(schedule.cadence).length > 24} corner={schedule.corner} />}
      descriptionLead={scheduleCadenceLabel(schedule.cadence)}
      key={schedule.id}
      leading={<View style={styles.leadingSlot}>
        {schedule.workflowSlug ? (
          <WorkflowGlyph color={styles.workflowGlyph.color} size={CORNER_META_SIZE} testID={`scheduled-work-glyph-${schedule.id}`} />
        ) : null}
      </View>}
      onPress={() => openSchedule(schedule)}
      testID={`scheduled-work-${schedule.id}`}
      title={scheduleTitle(schedule)}
    />
  );

  const renderSubscription = (subscription: RoomSubscriptionView) => (
    <SettingsRow
      chevron="right"
      description={`· @${work?.agentNames.get(subscription.agentId) ?? 'Agent'} · ${subscriptionWhere(subscription)}`}
      descriptionContent={<ListTail agent={work?.agentNames.get(subscription.agentId) ?? 'Agent'}
        compact={subscriptionWhen(subscription).length > 24} corner={subscription.corner} />}
      descriptionLead={subscriptionWhen(subscription)}
      key={subscription.id}
      leading={<View style={styles.leadingSlot}>
        {subscription.workflowSlug ? (
          <WorkflowGlyph color={styles.workflowGlyph.color} size={CORNER_META_SIZE} testID={`subscription-glyph-${subscription.id}`} />
        ) : null}
      </View>}
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
        backAccessibilityLabel="Back to Room"
        eyebrow={displayRoomIndexTitle(work?.roomName ?? undefined) ?? 'Room'}
        onBack={() => router.back()}
        testID="scheduled-work-header"
        title="Schedules and subscriptions"
      />
      {error && (
        <Pressable
          accessibilityRole="alert"
          onPress={retry}
          style={styles.error}
        >
          <Text style={styles.errorText}>{error} · Retry</Text>
        </Pressable>
      )}
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
                Agents set up schedules and subscriptions. Ask an agent in this Room to add one.
              </Text>
            </View>
          ) : <View style={styles.rows}>{entries.map((entry) => entry.kind === 'schedule'
            ? renderSchedule(entry.value) : renderSubscription(entry.value))}</View>}
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
  leadingSlot: { width: CORNER_META_SIZE, alignItems: 'center', justifyContent: 'center' },
  workflowGlyph: { color: theme.buzz.accent },
  listTail: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
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
