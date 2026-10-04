import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { observeRoomResource, useObservedResource } from '@/buzz/use-observed-resource';
import type { WorkflowRunDetailView, WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { cornerHref } from '@/buzz/corner-navigation';
import { useRoomLiveDrafts } from '@/buzz/room-live-drafts';
import { previewHandle } from '@/buzz/room-list-row';
import { liveRoomRuns } from '@/buzz/use-room-workflow-run';
import { workflowDisplayName, workflowStateLabel } from '@/buzz/workflow-graph';
import { formatRunDuration, runDayLabel, workflowRunHeadline, workflowRunHref, workflowStarterLine } from '@/buzz/workflow-run-copy';
import { HullLivePulse } from '@/components/buzz/MonoHull';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import {
  WorkflowRunLine,
  WorkflowStepCircle,
} from '@/components/buzz/WorkflowRunLine';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const LIVE_DOT = 10;
const LIVE_HALO = 20;

/**
 * One workflow run, read the way a GitHub Actions run reads: a status plate,
 * an optional workflow summary, then every contract step on one straight
 * rail — done, current, and upcoming (dimmed) — each with its one-line `does`
 * sentence plus the agent's live narration or final reply. The page only
 * records the run: it has no controls and no way back to the run's own
 * corner; Back returns to where the reader came from. Corners a step opened
 * are links.
 */
export default function WorkflowRun() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ roomId?: string | string[]; runId?: string | string[] }>();
  const roomId = first(params.roomId);
  const runId = first(params.runId);
  const { data: detail, loading, error, retry } = useObservedResource<WorkflowRunDetailView>(
    `workflow-run:${roomId}:${runId}`, {
      load: async () => {
        if (!roomId || !runId) throw new Error('Workflow run is missing.');
        if (!(await loadBuzzIdentity())) {
          router.replace('/beeline/onboarding' as Href);
          throw new Error('Sign in to read this workflow run.');
        }
        return monolithPhoneOperation('readWorkflowRun', { roomId, runId });
      },
      subscribe: roomId ? observeRoomResource(roomId) : undefined,
    },
  );
  const liveDrafts = useRoomLiveDrafts(detail?.run.status === 'live' ? roomId : undefined);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1_000));
  useEffect(() => {
    if (detail?.run.status !== 'live') return;
    setNow(Math.floor(Date.now() / 1_000));
    const clock = setInterval(() => setNow(Math.floor(Date.now() / 1_000)), 1000);
    return () => clearInterval(clock);
  }, [detail?.run.status]);

  const run = detail?.run;
  const live = run?.status === 'live';
  const last = detail?.history[detail.history.length - 1];
  const starter = detail ? workflowStarterLine(detail.run) || detail.history[0]?.actor?.name : undefined;
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <PageHeader
        backAccessibilityLabel="Back"
        eyebrow={run?.roomName ?? 'Workflow'}
        onBack={() => router.back()}
        testID="workflow-run-header"
        title={run ? workflowDisplayName(run.workflowSlug) : 'Workflow'}

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
      {loading && !detail ? (
        <View style={styles.loading}>
          <SurfaceGlyphLoader testID="workflow-run-loader" />
        </View>
      ) : detail && run ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
          testID="workflow-run-page"
        >
          {roomId ? (
            <Pressable accessibilityRole="button" style={styles.allRuns} onPress={() => router.push({ pathname: '/beeline/workflow', params: { roomId, name: run.workflowSlug } })}>
              <Text style={styles.allRunsText}>All runs</Text>
            </Pressable>
          ) : null}
          <View style={styles.plate} testID="workflow-run-summary">
            <View style={styles.status}>
              {live ? (
                <View style={styles.liveMark}>
                  <HullLivePulse style={styles.liveHalo}>
                    <View style={styles.liveRing} />
                  </HullLivePulse>
                  <View style={styles.liveDot} />
                </View>
              ) : (
                <WorkflowStepCircle status={run.status === 'done' ? 'done' : 'failed'} />
              )}
              <Text
                style={[styles.headline, run.viewerHolds && live && styles.brass]}
                testID="workflow-run-status"
              >
                {workflowRunHeadline(run, live ? undefined : last?.outcome)}
              </Text>
            </View>
            <Text style={styles.statusMeta} testID="workflow-run-started">
              {starter ? `${starter} · ` : ''}
              <Text style={styles.statusValue}>
                {`${runDayLabel(run.startedAt)} ${TIME.format(new Date(run.startedAt * 1_000))}`}
              </Text>
              {live ? ' · running ' : ' · took '}
              <Text style={styles.statusValue}>
                {formatRunDuration((live ? now : run.updatedAt) - run.startedAt)}
              </Text>
            </Text>
          </View>
          {detail.contract.summary ? (
            <View style={styles.summaryLine}>
              <View style={styles.summaryRail} />
              <Text style={styles.workflowSummary} testID="workflow-run-description">
                {detail.contract.summary}
              </Text>
            </View>
          ) : null}
          <View style={styles.section} testID="workflow-run-steps-header">
            <Text style={styles.sectionHead}>Steps</Text>
          </View>
          <WorkflowRunLine
            detail={detail}
            liveDrafts={liveDrafts}
            now={now}
            onOpenCorner={(corner) =>
              router.push(cornerHref(corner.id, corner.parentRoomId, corner.name))
            }
          />
          {roomId ? <AlsoRunning current={run} now={now} roomId={roomId} /> : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

/**
 * Every other live saved-workflow run in the corner, any workflow — a
 * section every run page shows alike (symmetric), so a corner running
 * several workflows at once can be read, and switched between, from any one
 * of their run pages. Tapping a row replaces this page in the navigation
 * stack, so Back from any run page always returns to the corner.
 */
function AlsoRunning({ roomId, current, now }: { roomId: string; current: WorkflowRunSummaryView; now: number }) {
  const { data: live } = useObservedResource<readonly WorkflowRunSummaryView[]>(
    `workflow-siblings:${roomId}`,
    {
      load: async () => {
        const { workflows } = await monolithPhoneOperation('listRoomWorkflowRuns', { roomId });
        return liveRoomRuns(roomId, workflows);
      },
      subscribe: observeRoomResource(roomId),
    },
  );
  const others = (live ?? []).filter((candidate) => candidate.runId !== current.runId);
  if (others.length === 0) return null;
  return (
    <View testID="workflow-run-also-running">
      <View style={styles.section}>
        <Text style={styles.sectionHead}>Also running in this corner</Text>
      </View>
      {others.map((other) => (
        <Pressable
          accessibilityLabel={`Open ${workflowDisplayName(other.workflowSlug)}, ${workflowStateLabel(other.state)}`}
          accessibilityRole="link"
          key={other.runId}
          onPress={() => router.replace(workflowRunHref(other))}
          style={({ pressed }) => [styles.alsoRunningRow, pressed && styles.pressed]}
          testID={`workflow-run-also-running-${other.runId}`}
        >
          <View style={styles.alsoRunningCopy}>
            <Text numberOfLines={1} style={styles.alsoRunningName}>
              {`${workflowDisplayName(other.workflowSlug)} · ${workflowStateLabel(other.state)}`}
            </Text>
            {other.holder ? (
              <Text numberOfLines={1} style={styles.alsoRunningHolder}>{`@${previewHandle(other.holder)}`}</Text>
            ) : null}
          </View>
          <Text style={styles.statusMeta}>{formatRunDuration(now - other.startedAt)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  allRuns: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.buzz.space.md },
  allRunsText: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  pressed: { backgroundColor: theme.buzz.bgPressed },
  alsoRunningRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.buzz.space.md,
    paddingVertical: theme.buzz.space.xs,
  },
  alsoRunningCopy: { flex: 1, minWidth: 0 },
  alsoRunningName: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  alsoRunningHolder: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, marginTop: theme.buzz.space.xs },
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  loading: { padding: theme.buzz.space.xl, alignItems: 'center', justifyContent: 'center' },
  plate: { paddingTop: theme.buzz.layout.screenTop, paddingHorizontal: theme.buzz.space.md },
  status: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.sm },
  liveMark: { width: LIVE_HALO, height: LIVE_HALO, alignItems: 'center', justifyContent: 'center' },
  liveHalo: { position: 'absolute', left: 0, top: 0, width: LIVE_HALO, height: LIVE_HALO },
  liveRing: {
    width: LIVE_HALO,
    height: LIVE_HALO,
    borderRadius: LIVE_HALO / 2,
    borderWidth: 1,
    borderColor: theme.buzz.accent,
  },
  liveDot: {
    width: LIVE_DOT,
    height: LIVE_DOT,
    borderRadius: LIVE_DOT / 2,
    backgroundColor: theme.buzz.accent,
  },
  headline: { ...theme.buzz.type.hero, flex: 1, color: theme.buzz.textPrimary },
  brass: { color: theme.buzz.accent },
  statusMeta: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, marginTop: 4 },
  statusValue: { color: theme.buzz.textSecondary },
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
  // The same rail + copy treatment as the corner's own objective line
  // (components/buzz/CornerObjectiveLine.tsx).
  summaryLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.buzz.space.sm,
    marginHorizontal: theme.buzz.space.md,
    marginVertical: theme.buzz.space.md,
  },
  summaryRail: { alignSelf: 'stretch', width: 2, backgroundColor: theme.buzz.humanRail },
  workflowSummary: {
    ...theme.buzz.type.meta,
    flex: 1,
    minWidth: 0,
    color: theme.buzz.textSecondary,
  },
  error: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.buzz.space.md,
    backgroundColor: theme.buzz.bgHighlight,
  },
  errorText: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
}));
