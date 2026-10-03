import React, { useEffect, useMemo, useState } from 'react';
import { WorkflowOwnership } from '@/components/buzz/WorkflowOwnership';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { observeRoomResource, useObservedResource } from '@/buzz/use-observed-resource';
import type { WorkflowRunDetailView } from '@beeline/api-contract/phone';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { cornerHref } from '@/buzz/corner-navigation';
import { useRoomLiveDrafts } from '@/buzz/room-live-drafts';
import { workflowDisplayName, workflowRunLine } from '@/buzz/workflow-graph';
import { formatRunDuration, runDayLabel, workflowRunHeadline, workflowStarterLine } from '@/buzz/workflow-run-copy';
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

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const LIVE_DOT = 10;
const LIVE_HALO = 20;

/**
 * One workflow run, read the way a GitHub Actions run reads (mock v12): a
 * status plate, an optional workflow summary, then each state on one
 * straight line, opening in place. The page only records the run: it has no
 * controls and no way back to the run's own corner; Back returns to where the
 * reader came from. Corners a step opened are links.
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

  const line = useMemo(
    () => (detail ? workflowRunLine(detail.contract, detail.history) : []),
    [detail],
  );
  const run = detail?.run;
  const live = run?.status === 'live';
  const last = detail?.history[detail.history.length - 1];
  const starter = detail ? workflowStarterLine(detail.run) || detail.history[0]?.actor?.name : undefined;
  const ran = line.filter((step) => step.visits.length > 0).length;
  const skipped = line.filter((step) => step.status === 'skipped').length;
  const done = line.filter((step) => step.status === 'done').length;
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
          {detail.ownership && roomId ? <>
            <WorkflowOwnership roomId={roomId} name={run.workflowSlug} ownership={detail.ownership} onChange={() => void retry()} />
            <Pressable accessibilityRole="button" style={styles.allRuns} onPress={() => router.push({ pathname: '/beeline/workflow', params: { roomId, name: run.workflowSlug } })}>
              <Text style={styles.allRunsText}>All runs</Text>
            </Pressable>
          </> : null}
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
            <Text style={styles.workflowSummary} testID="workflow-run-description">
              {detail.contract.summary}
            </Text>
          ) : null}
          <View style={styles.section}>
            <Text style={styles.sectionHead}>Steps</Text>
            <Text style={styles.sectionCount} testID="workflow-run-step-count">
              {live ? `${done} of ${line.length}` : `${ran} ran · ${skipped} skipped`}
            </Text>
          </View>
          <WorkflowRunLine
            detail={detail}
            liveDrafts={liveDrafts}
            now={now}
            onOpenCorner={(corner) =>
              router.push(cornerHref(corner.id, corner.parentRoomId, corner.name))
            }
          />

        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  allRuns: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.buzz.space.md },
  allRunsText: { ...theme.buzz.type.meta, color: theme.buzz.accent },
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
  sectionCount: { ...theme.buzz.type.machine, color: theme.buzz.ledgerGhost },
  workflowSummary: {
    ...theme.buzz.type.body,
    color: theme.buzz.textSecondary,
    paddingHorizontal: theme.buzz.space.md,
    paddingVertical: theme.buzz.space.md,
  },
  error: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.buzz.space.md,
    backgroundColor: theme.buzz.bgHighlight,
  },
  errorText: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
}));
