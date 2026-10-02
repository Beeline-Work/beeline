import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkflowRunDetailView } from '@beeline/api-contract/phone';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { cornerHref } from '@/buzz/corner-navigation';
import { workflowDisplayName, workflowRunLine } from '@/buzz/workflow-graph';
import { formatRunDuration, runDayLabel, workflowRunHeadline } from '@/buzz/workflow-run-copy';
import { HullLivePulse } from '@/components/buzz/MonoHull';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import {
  WorkflowRunLine,
  WorkflowRunOverview,
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
 * status plate, the whole run as a strip of circles, then each step on one
 * straight line, opening in place. The page only records the run: it has no
 * controls and no way back to the run's own corner; Back returns to where the
 * reader came from. Corners a step opened are links.
 */
export default function WorkflowRun() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ roomId?: string | string[]; runId?: string | string[] }>();
  const roomId = first(params.roomId);
  const runId = first(params.runId);
  const [detail, setDetail] = useState<WorkflowRunDetailView | null>(null);
  const [loadedAt, setLoadedAt] = useState(() => Math.floor(Date.now() / 1_000));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!roomId || !runId) {
      setError('Workflow run is missing.');
      setLoading(false);
      return;
    }
    try {
      if (!(await loadBuzzIdentity())) {
        router.replace('/beeline/onboarding' as Href);
        return;
      }
      setDetail(await monolithPhoneOperation('readWorkflowRun', { roomId, runId }));
      setLoadedAt(Math.floor(Date.now() / 1_000));
      setError(null);
    } catch (caught) {
      setError(`Could not load this workflow run: ${String(caught)}`);
    } finally {
      setLoading(false);
    }
  }, [roomId, runId]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const line = useMemo(
    () => (detail ? workflowRunLine(detail.contract, detail.history) : []),
    [detail],
  );
  const run = detail?.run;
  const live = run?.status === 'live';
  const last = detail?.history[detail.history.length - 1];
  const starter = detail?.history[0]?.actor?.name;
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
        {...(run
          ? {
              trailing: `#${run.earlierRunCount + 1}`,
              trailingAccessibilityLabel: `Run ${run.earlierRunCount + 1}`,
            }
          : {})}
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
      {loading && !detail ? (
        <View style={styles.loading}>
          <SurfaceGlyphLoader testID="workflow-run-loader" />
        </View>
      ) : detail && run ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
          testID="workflow-run-page"
        >
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
                {formatRunDuration((live ? loadedAt : run.updatedAt) - run.startedAt)}
              </Text>
            </Text>
          </View>
          <WorkflowRunOverview line={line} />
          <View style={styles.section}>
            <Text style={styles.sectionHead}>Steps</Text>
            <Text style={styles.sectionCount} testID="workflow-run-step-count">
              {live ? `${done} of ${line.length}` : `${ran} ran · ${skipped} skipped`}
            </Text>
          </View>
          <WorkflowRunLine
            detail={detail}
            now={loadedAt}
            onOpenCorner={(corner) =>
              router.push(cornerHref(corner.id, corner.parentRoomId, corner.name))
            }
          />
          <View style={styles.earlier} testID="workflow-run-earlier">
            <Text style={styles.earlierLabel}>Earlier runs</Text>
            <Text style={styles.earlierCount}>{run.earlierRunCount}</Text>
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  loading: { padding: 28, alignItems: 'center', justifyContent: 'center' },
  plate: { paddingTop: theme.buzz.layout.screenTop, paddingHorizontal: theme.buzz.space.md },
  status: { flexDirection: 'row', alignItems: 'center', gap: 12 },
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
  earlier: {
    minHeight: 48,
    marginTop: theme.buzz.space.md,
    paddingHorizontal: theme.buzz.space.md,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.buzz.border,
  },
  earlierLabel: { ...theme.buzz.type.meta, flex: 1, color: theme.buzz.textMuted },
  earlierCount: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  error: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.buzz.space.md,
    backgroundColor: theme.buzz.bgHighlight,
  },
  errorText: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
}));
