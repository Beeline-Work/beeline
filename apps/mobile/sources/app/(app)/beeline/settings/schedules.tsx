import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomScheduleView, RoomWebhooksResult } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { cornerHref } from '@/buzz/corner-navigation';
import { displayRoomIndexTitle } from '@/buzz/room-list-row';
import { scheduleCadenceLabel } from '@/buzz/schedule-cadence';
import { CORNER_META_SIZE, CornerGlyph } from '@/components/buzz/CornerGlyph';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const NEXT_RUN = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Everything that wakes the Room's agents without a human tag: timers and
 * webhooks. Agents set both up. Room managers can only inspect, stop a
 * schedule, or revoke a webhook. The page wears the shared section header
 * (Room name over Schedules and Webhooks); workflow runs are reached from a
 * corner's objective panel.
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
  const [roomName, setRoomName] = useState<string | null>(null);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [schedules, setSchedules] = useState<readonly RoomScheduleView[]>([]);
  const [webhooks, setWebhooks] = useState<RoomWebhooksResult | null>(null);
  const [loading, setLoading] = useState(true);
  useLatencyRouteFrame('/beeline/settings/schedules', !loading, true);
  const [working, setWorking] = useState(false);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!roomId || !workspaceId) {
      setError('Schedules target is missing.');
      setLoading(false);
      return;
    }
    try {
      const identity = await loadBuzzIdentity();
      if (!identity) {
        router.replace('/beeline/onboarding' as Href);
        return;
      }
      const relayUrl = await getEffectiveRelayUrl();
      const room = await new RoomViewClient({ baseUrl: relayUrl, identity }).room(roomId);
      if (!room.viewer.permissions.manage) throw new Error('Room manager required');
      const [listed, hooks] = await Promise.all([
        monolithPhoneOperation('listRoomSchedules', { roomId }),
        monolithPhoneOperation('readRoomWebhooks', { roomId }),
      ]);
      setRoomName(room.room.name);
      setAgents(
        room.members
          .filter((member) => member.identity.kind === 'agent')
          .map((member) => ({ id: member.identity.pubkey, name: member.identity.name })),
      );
      setSchedules(listed.schedules);
      setWebhooks(hooks);
      setError(null);
    } catch (caught) {
      setError(`Could not load schedules and webhooks: ${String(caught)}`);
    } finally {
      setLoading(false);
    }
  }, [roomId, workspaceId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void reload();
    }, [reload]),
  );

  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name] as const)),
    [agents],
  );
  const stop = useCallback(
    async (scheduleId: string) => {
      if (!roomId) return;
      setWorking(true);
      setError(null);
      try {
        await monolithPhoneOperation('deleteRoomSchedule', { roomId, scheduleId });
        setConfirmStop(null);
        setSchedules((current) => current.filter((schedule) => schedule.id !== scheduleId));
      } catch (caught) {
        setError(`Could not stop scheduled work: ${String(caught)}`);
      } finally {
        setWorking(false);
      }
    },
    [roomId],
  );

  const revoke = useCallback(
    async (webhookId: string) => {
      if (!roomId) return;
      setWorking(true);
      setError(null);
      try {
        await monolithPhoneOperation('manageRoomWebhook', { roomId, action: 'revoke', webhookId });
        setWebhooks((current) =>
          current && {
            ...current,
            sources: current.sources.filter((hook) => hook.id !== webhookId),
          },
        );
      } catch (caught) {
        setError(`Could not revoke webhook: ${String(caught)}`);
      } finally {
        setWorking(false);
      }
    },
    [roomId],
  );

  const liveWebhooks = useMemo(
    () => webhooks?.sources.filter((hook) => !hook.revoked) ?? [],
    [webhooks],
  );
  // Deliveries arrive newest first, so the first one per source is its last.
  const lastFired = useMemo(() => {
    const last = new Map<string, number>();
    for (const delivery of webhooks?.deliveries ?? [])
      if (!last.has(delivery.source)) last.set(delivery.source, delivery.receivedAt);
    return last;
  }, [webhooks]);

  const renderWebhook = (hook: RoomWebhooksResult['sources'][number]) => {
    const fired = lastFired.get(hook.source);
    return (
      <View key={hook.id} style={styles.row} testID={`webhook-${hook.id}`}>
        <View style={styles.cadenceLine}>
          <Text numberOfLines={1} style={styles.cadence}>
            {hook.source}
          </Text>
          <Text numberOfLines={1} style={styles.next}>
            {fired ? `LAST ${NEXT_RUN.format(new Date(fired * 1_000))}` : 'NEVER FIRED'}
          </Text>
        </View>
        <Text numberOfLines={1} style={styles.agent}>
          {hook.agents.length
            ? hook.agents.map((name) => `@${name}`).join(' · ')
            : 'No agent subscribed'}
        </Text>
        <View style={styles.rowFooter}>
          <Text numberOfLines={1} style={styles.cornerName}>
            {hook.signed ? 'Signed' : 'Unsigned'}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={working}
            onPress={() => void revoke(hook.id)}
            style={styles.stopAction}
            testID={`revoke-webhook-${hook.id}`}
          >
            <Text style={styles.stopText}>REVOKE</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderSchedule = (schedule: RoomScheduleView) => {
    const confirming = confirmStop === schedule.id;
    const corner = schedule.corner;
    return (
      <Pressable
        accessibilityLabel={corner ? `Open ${corner.name} corner` : undefined}
        accessibilityRole={corner ? 'button' : undefined}
        key={schedule.id}
        onPress={
          corner ? () => router.push(cornerHref(corner.id, roomId!, corner.name)) : undefined
        }
        style={({ pressed }) => [styles.row, corner && pressed && styles.rowPressed]}
        testID={`scheduled-work-${schedule.id}`}
      >
        <View style={styles.cadenceLine}>
          <Text style={styles.cadence}>{scheduleCadenceLabel(schedule.cadence)}</Text>
          <Text numberOfLines={1} style={styles.next}>
            NEXT {NEXT_RUN.format(new Date(schedule.nextRunAt * 1_000))}
          </Text>
        </View>
        <Text numberOfLines={1} style={styles.agent}>
          @{agentNames.get(schedule.agentId) ?? 'Agent'}
        </Text>
        <Text style={styles.message}>{schedule.message}</Text>
        <View style={styles.rowFooter}>
          {corner ? (
            <View style={styles.corner} testID={`open-scheduled-work-${schedule.id}`}>
              <CornerGlyph size={CORNER_META_SIZE} />
              <Text numberOfLines={1} style={styles.cornerName}>
                {corner.name}
              </Text>
            </View>
          ) : (
            <View style={styles.corner} />
          )}
          <TouchableOpacity
            accessibilityRole="button"
            disabled={working}
            onPress={(event) => {
              event.stopPropagation();
              setConfirmStop(confirming ? null : schedule.id);
            }}
            style={styles.stopAction}
            testID={`stop-scheduled-work-${schedule.id}`}
          >
            <Text style={styles.stopText}>{confirming ? 'CANCEL' : 'STOP'}</Text>
          </TouchableOpacity>
          {confirming && (
            <TouchableOpacity
              accessibilityRole="button"
              disabled={working}
              onPress={(event) => {
                event.stopPropagation();
                void stop(schedule.id);
              }}
              style={styles.stopAction}
            >
              <Text style={styles.confirmText}>CONFIRM STOP</Text>
            </TouchableOpacity>
          )}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <PageHeader
        backAccessibilityLabel="Back to Room"
        eyebrow={displayRoomIndexTitle(roomName ?? undefined) ?? 'Room'}
        onBack={() => router.back()}
        testID="scheduled-work-header"
        title="Schedules and Webhooks"
      />
      {error && (
        <Pressable
          accessibilityRole="alert"
          onPress={() => {
            setLoading(true);
            void reload();
          }}
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
              {schedules.map(renderSchedule)}
              {liveWebhooks.length > 0 && <Text style={styles.section}>WEBHOOKS</Text>}
              {liveWebhooks.map(renderWebhook)}
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
  row: {
    padding: 16,
    paddingBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  rowPressed: { backgroundColor: theme.buzz.bgHighlight },
  section: {
    ...theme.buzz.type.sectionHead,
    color: theme.buzz.ledgerQuiet,
    paddingHorizontal: 16,
    paddingTop: theme.buzz.space.lg,
    paddingBottom: theme.buzz.space.xs,
  },
  cadenceLine: { flexDirection: 'row', alignItems: 'baseline', gap: theme.buzz.space.sm },
  cadence: { ...theme.buzz.type.meta, flex: 1, color: theme.buzz.textPrimary },
  next: { ...theme.buzz.type.meta, flexShrink: 0, color: theme.buzz.ledgerQuiet },
  agent: { ...theme.buzz.type.meta, color: theme.buzz.accent, marginTop: theme.buzz.space.sm },
  message: { ...theme.buzz.type.body, color: theme.buzz.textSecondary, marginTop: theme.buzz.space.xs },
  rowFooter: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.md, marginTop: 4 },
  corner: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  cornerName: { ...theme.buzz.type.meta, flex: 1, color: theme.buzz.textSecondary },
  stopAction: { minHeight: 44, justifyContent: 'center' },
  stopText: { ...theme.buzz.type.sectionHead, color: theme.buzz.textSecondary },
  confirmText: { ...theme.buzz.type.sectionHead, color: theme.buzz.danger },
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
