import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomScheduleView, WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { cornerHref } from '@/buzz/corner-navigation';
import { displayRoomIndexTitle } from '@/buzz/room-list-row';
import { scheduleCadenceLabel } from '@/buzz/schedule-cadence';
import { workflowDisplayName, workflowStateLabel } from '@/buzz/workflow-graph';
import { workflowRunHref } from '@/buzz/workflow-run-copy';
import { CORNER_META_SIZE, CornerGlyph } from '@/components/buzz/CornerGlyph';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { WorkflowGlyph } from '@/components/buzz/WorkflowGlyph';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import {
  MonolithPhoneOperationError,
  monolithPhoneOperation,
} from '@/sync/transport/monolith-operation';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const NEXT_RUN = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const LAST_RUN = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** The Room's workflow runs; a server without the operation has none to show. */
async function listWorkflowRuns(roomId: string): Promise<readonly WorkflowRunSummaryView[]> {
  try {
    return (await monolithPhoneOperation('listRoomWorkflowRuns', { roomId })).workflows;
  } catch (caught) {
    if (caught instanceof MonolithPhoneOperationError && caught.status === 404) return [];
    throw caught;
  }
}

/**
 * Agents control recurring work. Room managers can only inspect or stop it.
 * The page wears the shared section header (Room name over Scheduled Work, the
 * corner and workflow-run pages' title role). Workflows come first: each
 * agent workflow's newest run in this Room and its corners, opening the run's
 * state graph rather than the corner it happens to run in.
 */
export default function ScheduledWork() {
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
  const [workflows, setWorkflows] = useState<readonly WorkflowRunSummaryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!roomId || !workspaceId) {
      setError('Scheduled-work target is missing.');
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
      const [listed, runs] = await Promise.all([
        monolithPhoneOperation('listRoomSchedules', { roomId }),
        listWorkflowRuns(roomId),
      ]);
      setRoomName(room.room.name);
      setAgents(
        room.members
          .filter((member) => member.identity.kind === 'agent')
          .map((member) => ({ id: member.identity.pubkey, name: member.identity.name })),
      );
      setSchedules(listed.schedules);
      setWorkflows(runs);
      setError(null);
    } catch (caught) {
      setError(`Could not load scheduled work: ${String(caught)}`);
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
        await reload();
      } catch (caught) {
        setError(`Could not stop scheduled work: ${String(caught)}`);
      } finally {
        setWorking(false);
      }
    },
    [reload, roomId],
  );

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

  const renderWorkflow = (run: WorkflowRunSummaryView) => {
    const live = run.status === 'live';
    const open = () => router.push(workflowRunHref(run));
    return (
      <Pressable
        accessibilityLabel={`Open ${workflowDisplayName(run.workflowSlug)} workflow`}
        accessibilityRole="button"
        key={`${run.roomId}:${run.runId}`}
        onPress={open}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        testID={`scheduled-workflow-${run.workflowSlug}`}
      >
        <View style={styles.cadenceLine}>
          <View style={styles.workflowName}>
            <WorkflowGlyph
              color={live ? undefined : styles.idleGlyph.color}
              live={live}
              size={CORNER_META_SIZE}
            />
            <Text numberOfLines={1} style={styles.cadence}>
              {workflowDisplayName(run.workflowSlug)}
            </Text>
          </View>
          <Text numberOfLines={1} style={live ? styles.workflowStep : styles.next}>
            {live
              ? `${workflowStateLabel(run.state)}${run.viewerHolds ? ' · you' : ''}`
              : `Last run ${LAST_RUN.format(new Date(run.updatedAt * 1_000))}`}
          </Text>
        </View>
        {run.holder ? (
          <Text numberOfLines={1} style={styles.agent}>
            @{run.holder.name}
          </Text>
        ) : null}
        <Text style={styles.message}>{run.description}</Text>
        <View style={styles.rowFooter}>
          <View style={styles.corner}>
            {run.parentRoomId ? (
              <CornerGlyph
                color={live ? undefined : styles.idleGlyph.color}
                size={CORNER_META_SIZE}
              />
            ) : null}
            <Text numberOfLines={1} style={[styles.cornerName, !live && styles.idleCorner]}>
              {run.roomName}
            </Text>
          </View>
          <Pressable
            accessibilityRole="link"
            onPress={(event) => {
              event.stopPropagation();
              open();
            }}
            style={styles.stopAction}
            testID={`open-scheduled-workflow-${run.workflowSlug}`}
          >
            <Text style={styles.openText}>Open →</Text>
          </Pressable>
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
        title="Scheduled Work"
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
          {workflows.length > 0 && (
            <>
              <View style={styles.section} testID="scheduled-work-workflows">
                <Text style={styles.sectionHead}>Workflows</Text>
                <Text style={styles.sectionCount}>{workflows.length}</Text>
              </View>
              {workflows.map(renderWorkflow)}
            </>
          )}
          {schedules.length === 0 && workflows.length === 0 ? (
            <View style={styles.emptyBlock} testID="scheduled-work-empty">
              <Ionicons color={styles.emptyIcon.color} name="time-outline" size={22} />
              <Text style={styles.emptyTitle}>No scheduled work</Text>
              <Text style={styles.empty}>Agents in this Room have nothing on a schedule.</Text>
            </View>
          ) : schedules.length > 0 ? (
            <>
              {workflows.length > 0 && (
                <View style={styles.section} testID="scheduled-work-schedules">
                  <Text style={styles.sectionHead}>Schedules</Text>
                  <Text style={styles.sectionCount}>{schedules.length}</Text>
                </View>
              )}
              {schedules.map(renderSchedule)}
            </>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  loading: { padding: 28, alignItems: 'center', justifyContent: 'center' },
  row: {
    padding: 16,
    paddingBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  rowPressed: { backgroundColor: theme.buzz.bgHighlight },
  cadenceLine: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  cadence: { ...theme.buzz.type.meta, flex: 1, color: theme.buzz.textPrimary },
  workflowName: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  workflowStep: { ...theme.buzz.type.meta, flexShrink: 0, color: theme.buzz.accent },
  idleGlyph: { color: theme.buzz.ledgerGhost },
  idleCorner: { color: theme.buzz.ledgerGhost },
  openText: { ...theme.buzz.type.sectionHead, color: theme.buzz.accent },
  section: {
    minHeight: 32,
    marginTop: theme.buzz.layout.sectionGap,
    paddingHorizontal: theme.buzz.space.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  sectionHead: { ...theme.buzz.type.sectionHead, color: theme.buzz.ledgerQuiet },
  sectionCount: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  next: { ...theme.buzz.type.meta, flexShrink: 0, color: theme.buzz.ledgerQuiet },
  agent: { ...theme.buzz.type.meta, color: theme.buzz.accent, marginTop: 12 },
  message: { ...theme.buzz.type.body, color: theme.buzz.textSecondary, marginTop: 5 },
  rowFooter: { flexDirection: 'row', alignItems: 'center', gap: 20, marginTop: 4 },
  corner: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  cornerName: { ...theme.buzz.type.meta, flex: 1, color: theme.buzz.textSecondary },
  stopAction: { minHeight: 44, justifyContent: 'center' },
  stopText: { ...theme.buzz.type.sectionHead, color: theme.buzz.textSecondary },
  confirmText: { ...theme.buzz.type.sectionHead, color: theme.buzz.danger },
  emptyBlock: { padding: 28, alignItems: 'flex-start', justifyContent: 'center' },
  emptyIcon: { color: theme.buzz.accent },
  emptyTitle: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary, marginTop: 10 },
  empty: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary, marginTop: 6 },
  error: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    backgroundColor: theme.buzz.bgHighlight,
  },
  errorText: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
}));
