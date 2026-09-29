import React, { useCallback, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { RoomWorkflowListResult, RoomWorkflowView } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { Typography } from '@/constants/Typography';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Modal } from '@/modal/ModalManager';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { MonoButton } from '@/components/buzz/MonoHull';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const LAST_RUN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * A workflow step addressed to a class of agents (a tier or a tag) rather
 * than one agent: the server picks a healthy member of the class, fails over
 * inside the class, and asks a person here when the class is exhausted.
 */
function ClassStepForm({ roomId }: { roomId: string }) {
  const { theme } = useUnistyles();
  const [agentClass, setAgentClass] = useState('heavy');
  const [role, setRole] = useState('review');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const run = async () => {
    if (busy || !prompt.trim()) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await monolithPhoneOperation('dispatchClassStep', {
        roomId,
        agentClass: agentClass.trim().toLowerCase(),
        role: role.trim().toLowerCase(),
        prompt: prompt.trim(),
      });
      setPrompt('');
      setOutcome(
        result.agentId
          ? 'Sent to a healthy agent in the class. Follow it in the Room.'
          : 'No healthy agent carries that class. The Room was asked what to do.',
      );
    } catch (caught) {
      setOutcome(`! Could not run the step: ${String(caught)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.classStep} testID="class-step-form">
      <Text style={styles.sectionLabel}>Run a step by class</Text>
      <Text style={styles.notice}>
        Name a tier (god, heavy, light) or a tag. A healthy agent in the class takes the step; if
        it fails, the next one does.
      </Text>
      <View style={styles.classStepRow}>
        <TextInput
          accessibilityLabel="Class"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setAgentClass}
          placeholder="class"
          placeholderTextColor={theme.buzz.dim}
          style={[styles.input, styles.classStepField]}
          testID="class-step-class"
          value={agentClass}
        />
        <TextInput
          accessibilityLabel="Role"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setRole}
          placeholder="role"
          placeholderTextColor={theme.buzz.dim}
          style={[styles.input, styles.classStepField]}
          testID="class-step-role"
          value={role}
        />
      </View>
      <TextInput
        accessibilityLabel="Step prompt"
        multiline
        onChangeText={setPrompt}
        placeholder="What should the step do?"
        placeholderTextColor={theme.buzz.dim}
        style={[styles.input, styles.classStepPrompt]}
        testID="class-step-prompt"
        value={prompt}
      />
      <MonoButton
        disabled={busy || !prompt.trim() || !agentClass.trim() || !role.trim()}
        label={busy ? 'Running…' : 'Run step'}
        loading={busy}
        onPress={() => void run()}
        testID="class-step-run"
      />
      {outcome ? (
        <Text accessibilityRole="alert" style={styles.notice} testID="class-step-outcome">
          {outcome}
        </Text>
      ) : null}
    </View>
  );
}

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
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {roomId && !error ? <ClassStepForm roomId={roomId} /> : null}
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
  classStep: { gap: 8, paddingBottom: 16 },
  classStepRow: { flexDirection: 'row', gap: 8 },
  classStepField: { flex: 1 },
  classStepPrompt: { minHeight: 88, paddingVertical: 8, textAlignVertical: 'top' },
  sectionLabel: {
    ...Typography.default(),
    ...theme.buzz.type.sectionHead,
    color: theme.buzz.textMuted,
  },
  input: {
    ...Typography.default(),
    ...theme.buzz.type.body,
    minHeight: 40,
    paddingHorizontal: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.radius,
    color: theme.buzz.textPrimary,
  },
  error: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.danger },
}));
