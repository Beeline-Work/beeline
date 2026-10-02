import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkflowRunDetailView } from '@beeline/api-contract/phone';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { workflowDisplayName } from '@/buzz/workflow-graph';
import { runDayLabel, workflowRunRoomHref } from '@/buzz/workflow-run-copy';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { WorkflowRunGraph } from '@/components/buzz/WorkflowRunGraph';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
/**
 * One workflow run as its whole state machine (mock v11 frame C): the corner it
 * works in over the workflow's name, when the run started, the graph, and how
 * many earlier runs there were. The corner keeps the one-line summary; only
 * this page draws the graph.
 */
export default function WorkflowRun() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ roomId?: string | string[]; runId?: string | string[] }>();
  const roomId = first(params.roomId);
  const runId = first(params.runId);
  const [detail, setDetail] = useState<WorkflowRunDetailView | null>(null);
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

  const run = detail?.run;
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
          <View style={styles.section} testID="workflow-run-started">
            <Text style={styles.sectionHead}>{runDayLabel(run.startedAt)}</Text>
            <Text style={styles.sectionTime}>{TIME.format(new Date(run.startedAt * 1_000))}</Text>
          </View>
          <WorkflowRunGraph detail={detail} onOpenRoom={() => router.push(workflowRunRoomHref(run))} />
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
  sectionTime: { ...theme.buzz.type.machine, color: theme.buzz.ledgerGhost },
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
