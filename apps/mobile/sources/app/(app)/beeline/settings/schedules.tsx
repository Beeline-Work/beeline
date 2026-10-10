import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { roomTitle, type RoomScheduleView } from '@beeline/api-contract/phone';
import {
  handles,
  scheduleTitle,
  scheduleWhere,
  useScheduledWork,
  webhookTitle,
  type RoomWebhookView,
} from '@/buzz/scheduled-work';
import { CORNER_META_SIZE } from '@/components/buzz/CornerGlyph';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { WorkflowGlyph } from '@/components/buzz/WorkflowGlyph';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Everything that wakes the Room's agents without a human tag: timers and
 * webhooks. Agents set both up. Each entry is one settings row in the same
 * grammar — what it runs · when it runs, over who · where — and opens its own
 * page: a workflow schedule the workflow's page, a prompt schedule its full
 * prompt, a webhook what makes it fire. Stopping happens on those pages.
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
  const liveWebhooks = work?.webhooks ?? [];

  const openSchedule = (schedule: RoomScheduleView) =>
    router.push(
      schedule.workflowSlug
        ? {
            pathname: '/beeline/workflow',
            params: {
              roomId: schedule.roomId,
              name: schedule.workflowSlug,
              scheduleId: schedule.id,
              parentRoomId: roomId!,
            },
          }
        : {
            pathname: '/beeline/settings/schedule',
            params: { roomId: roomId!, scheduleId: schedule.id },
          },
    );

  const renderSchedule = (schedule: RoomScheduleView) => (
    <SettingsRow
      chevron="right"
      description={`@${work?.agentNames.get(schedule.agentId) ?? 'Agent'} · ${scheduleWhere(schedule)}`}
      key={schedule.id}
      leading={
        schedule.workflowSlug ? (
          <WorkflowGlyph live={false} size={CORNER_META_SIZE} testID={`scheduled-work-glyph-${schedule.id}`} />
        ) : undefined
      }
      onPress={() => openSchedule(schedule)}
      testID={`scheduled-work-${schedule.id}`}
      title={scheduleTitle(schedule)}
    />
  );

  const renderWebhook = (hook: RoomWebhookView) => (
    <SettingsRow
      chevron="right"
      description={`${handles(hook.agents)} · this Room`}
      key={hook.id}
      onPress={() =>
        router.push({
          pathname: '/beeline/settings/webhook',
          params: { roomId: roomId!, webhookId: hook.id },
        })
      }
      testID={`webhook-${hook.id}`}
      title={webhookTitle(hook)}
    />
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <PageHeader
        backAccessibilityLabel="Back to Room"
        eyebrow={roomTitle(work?.roomName) ?? 'Room'}
        onBack={() => router.back()}
        testID="scheduled-work-header"
        title="Schedules and Webhooks"
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
          {schedules.length === 0 && liveWebhooks.length === 0 ? (
            <View style={styles.emptyBlock} testID="scheduled-work-empty">
              <Ionicons color={styles.emptyIcon.color} name="time-outline" size={22} />
              <Text style={styles.emptyTitle}>Nothing wakes agents here yet</Text>
              <Text style={styles.empty}>
                Agents set up schedules and webhooks. Ask an agent in this Room to add one.
              </Text>
            </View>
          ) : (
            <>
              {schedules.length > 0 && <Text style={styles.section}>SCHEDULES</Text>}
              <View style={styles.rows}>{schedules.map(renderSchedule)}</View>
              {liveWebhooks.length > 0 && <Text style={styles.section}>WEBHOOKS</Text>}
              <View style={styles.rows}>{liveWebhooks.map(renderWebhook)}</View>
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  loading: { padding: theme.buzz.space.xl, alignItems: 'center', justifyContent: 'center' },
  section: {
    ...theme.buzz.type.sectionHead,
    color: theme.buzz.ledgerQuiet,
    paddingHorizontal: 16,
    paddingTop: theme.buzz.space.lg,
    paddingBottom: theme.buzz.space.xs,
  },
  // SettingsRow pads by `space.sm`; the section heads sit at 16.
  rows: { paddingHorizontal: theme.buzz.space.sm },
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
