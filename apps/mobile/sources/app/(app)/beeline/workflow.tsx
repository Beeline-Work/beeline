import { workflowRunHref } from '@/buzz/workflow-run-copy';
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { workflowDisplayName } from '@/buzz/workflow-graph';
import { workflowStarterLine } from '@/buzz/workflow-run-copy';
import { PageHeader } from '@/components/buzz/PageHeader';
import { WorkflowOwnership } from '@/components/buzz/WorkflowOwnership';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

export default function Workflow() {
  const params = useLocalSearchParams<{ roomId: string; name?: string }>();
  const roomId = Array.isArray(params.roomId) ? params.roomId[0] : params.roomId;
  const name = Array.isArray(params.name) ? params.name[0] : params.name;
  const insets = useSafeAreaInsets();
  const [detail, setDetail] = useState<
    PhoneOperationMap['readWorkflowDefinition']['output'] | null
  >(null);
  const [definitions, setDefinitions] = useState<
    PhoneOperationMap['listWorkflowDefinitions']['output'] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      if (name) {
        setDefinitions(null);
        setDetail(await monolithPhoneOperation('readWorkflowDefinition', { roomId, name }));
      } else {
        setDetail(null);
        setDefinitions(await monolithPhoneOperation('listWorkflowDefinitions', { roomId }));
      }
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
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <PageHeader
        title={name ? workflowDisplayName(name) : 'Workflows'}
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
      {!detail && !definitions && !error ? <SurfaceGlyphLoader /> : null}
      {definitions ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}>
          {definitions.workflows.map((workflow) => (
            <Pressable
              key={workflow.name}
              accessibilityRole="button"
              style={styles.run}
              onPress={() =>
                router.push({
                  pathname: '/beeline/workflow',
                  params: { roomId, name: workflow.name },
                })
              }
            >
              <Text style={styles.title}>{workflowDisplayName(workflow.name)}</Text>
              <Text style={styles.meta}>
                {workflow.ownership.owner
                  ? `Owner ${workflow.ownership.owner.name}`
                  : 'no owner, starts blocked'}
              </Text>
            </Pressable>
          ))}
          {!definitions.workflows.length ? (
            <Text style={styles.description}>No saved workflows.</Text>
          ) : null}
        </ScrollView>
      ) : null}
      {detail && name ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}>
          <WorkflowOwnership
            roomId={roomId}
            name={name}
            ownership={detail.ownership}
            onChange={() => void reload()}
          />
          <Text style={styles.description}>
            {detail.contract.summary ?? detail.contract.description}
          </Text>
          <Text style={styles.heading}>Runs</Text>
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
                {run.status === 'live' ? 'Running' : run.status === 'done' ? 'Completed' : 'Failed'}
              </Text>
              <Text style={styles.meta}>{workflowStarterLine(run)}</Text>
              <Text selectable style={styles.id}>
                {run.runId}
              </Text>
            </Pressable>
          ))}
          {!detail.runs.length ? <Text style={styles.description}>No runs yet.</Text> : null}
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
