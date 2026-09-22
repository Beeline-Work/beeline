import React, { useCallback, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomWorkflowListResult, RoomWorkflowView } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { Typography } from '@/constants/Typography';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Modal } from '@/modal/ModalManager';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const LAST_RUN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Repository workflows remain a Room-manager action; this route is only an entry surface. */
export default function RoomWorkflows() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ roomId?: string | string[] }>();
  const roomId = first(params.roomId);
  const [roomName, setRoomName] = useState('Room');
  const [list, setList] = useState<RoomWorkflowListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!roomId) {
      setError('Workflow target is missing.');
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
      if (room.repositoryResolution !== 'repository') throw new Error('Room repository required');
      const workflows = await monolithPhoneOperation('listRoomWorkflows', { roomId });
      setRoomName(room.room.name);
      setList(workflows);
      setError(null);
    } catch (caught) {
      setError(`Could not load workflows: ${String(caught)}`);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void reload();
    }, [reload]),
  );

  const run = useCallback(
    async (workflow: RoomWorkflowView) => {
      if (!roomId || !list || running) return;
      const confirmed = await Modal.confirm(
        `Run ${workflow.name}?`,
        `Run ${workflow.name} on ${list.defaultBranch}?`,
        { cancelText: 'Cancel', confirmText: 'Run' },
      );
      if (!confirmed) return;
      setRunning(workflow.name);
      setError(null);
      try {
        await monolithPhoneOperation('dispatchRoomWorkflow', {
          roomId,
          workflowName: workflow.name,
        });
        await reload();
      } catch (caught) {
        setError(`Could not run ${workflow.name}: ${String(caught)}`);
      } finally {
        setRunning(null);
      }
    },
    [list, reload, roomId, running],
  );

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Text numberOfLines={1} style={styles.subtitle} testID="workflows-room">
          {roomName}
        </Text>
      </View>
      {loading ? (
        <View style={styles.loading}>
          <SurfaceGlyphLoader testID="workflows-loader" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.notice}>
            Dispatches run on {list?.defaultBranch ?? 'the repository default branch'}.
          </Text>
          {list?.workflows.length ? (
            list.workflows.map((workflow) => {
              const busy = running === workflow.name;
              const lastRun = workflow.lastRunAt
                ? `${LAST_RUN.format(new Date(workflow.lastRunAt * 1_000))} · ${workflow.conclusion ?? 'running'}`
                : 'Never run';
              return (
                <TouchableOpacity
                  accessibilityLabel={`Run ${workflow.name}`}
                  accessibilityRole="button"
                  disabled={Boolean(running)}
                  key={workflow.name}
                  onPress={() => void run(workflow)}
                  style={styles.workflowRow}
                  testID={`room-workflow-${workflow.name}`}
                >
                  <View style={styles.workflowCopy}>
                    <Text style={styles.workflowName}>{workflow.name}</Text>
                    <Text style={styles.workflowMeta}>{lastRun}</Text>
                  </View>
                  <View style={styles.run}>
                    <Text style={styles.runText}>{busy ? 'RUNNING…' : 'RUN'}</Text>
                    {!busy ? (
                      <ChevronGlyph
                        color={styles.runGlyph.color}
                        direction="right"
                        size={CHEVRON_ROW_SIZE}
                      />
                    ) : null}
                  </View>
                </TouchableOpacity>
              );
            })
          ) : (
            <Text style={styles.empty}>No dispatchable workflows in this Room.</Text>
          )}
          {error && (
            <Text accessibilityRole="alert" style={styles.error}>
              ! {error}
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.buzz.bgTerminal },
  header: { paddingHorizontal: 16, paddingTop: 8 },
  subtitle: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 10 },
  notice: {
    ...Typography.default(),
    ...theme.buzz.type.meta,
    color: theme.buzz.textMuted,
    marginBottom: 2,
  },
  workflowRow: {
    minHeight: 58,
    borderTopWidth: 1,
    borderTopColor: theme.buzz.border,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  workflowCopy: { flex: 1, minWidth: 0, gap: 4 },
  workflowName: {
    ...Typography.default('semiBold'),
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
  },
  workflowMeta: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  run: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.xs },
  runText: {
    ...Typography.default('semiBold'),
    ...theme.buzz.type.sectionHead,
    color: theme.buzz.accent,
  },
  runGlyph: { color: theme.buzz.accent },
  empty: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  error: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.danger },
}));
