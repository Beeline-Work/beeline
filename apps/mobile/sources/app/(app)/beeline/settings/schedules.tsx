import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { RoomScheduleCadence, RoomScheduleView } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import { MonoButton, PixelLoader } from '@/components/buzz/MonoHull';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function cadenceLabel(cadence: RoomScheduleCadence): string {
  return cadence.kind === 'cron'
    ? `${cadence.expression} · ${cadence.timeZone ?? 'UTC'}`
    : `Every ${cadence.everyMinutes} minute${cadence.everyMinutes === 1 ? '' : 's'}`;
}

const NEXT_RUN = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export default function RoomSchedulesSettings() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    roomId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const roomId = first(params.roomId);
  const workspaceId = first(params.workspaceId);
  const [roomName, setRoomName] = useState('Room');
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [schedules, setSchedules] = useState<readonly RoomScheduleView[]>([]);
  const [agentId, setAgentId] = useState('');
  const [kind, setKind] = useState<'cron' | 'interval'>('interval');
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [minutes, setMinutes] = useState('60');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!roomId || !workspaceId) {
      setError('Schedule target is missing.');
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
      const nextAgents = room.members
        .filter((member) => member.identity.kind === 'agent')
        .map((member) => ({ id: member.identity.pubkey, name: member.identity.name }));
      const listed = await monolithPhoneOperation('listRoomSchedules', { roomId });
      setRoomName(room.room.name);
      setAgents(nextAgents);
      setAgentId((current) =>
        nextAgents.some((agent) => agent.id === current) ? current : (nextAgents[0]?.id ?? ''),
      );
      setSchedules(listed.schedules);
      setError(null);
    } catch (caught) {
      setError(`Could not load schedules: ${String(caught)}`);
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

  const validMinutes = useMemo(() => {
    const value = Number(minutes);
    return Number.isSafeInteger(value) && value >= 1 && value <= 366 * 24 * 60;
  }, [minutes]);
  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name] as const)),
    [agents],
  );
  const canCreate =
    Boolean(agentId && message.trim()) && (kind === 'cron' ? Boolean(cron.trim()) : validMinutes);

  const create = useCallback(async () => {
    if (!roomId || !workspaceId || !canCreate) return;
    setWorking(true);
    setError(null);
    try {
      const cadence: RoomScheduleCadence =
        kind === 'cron'
          ? { kind: 'cron', expression: cron.trim(), timeZone: 'UTC' }
          : { kind: 'interval', everyMinutes: Number(minutes) };
      await monolithPhoneOperation('createRoomSchedule', {
        workspaceId,
        roomId,
        agentId,
        cadence,
        message: message.trim(),
      });
      setMessage('');
      await reload();
    } catch (caught) {
      setError(`Could not add schedule: ${String(caught)}`);
    } finally {
      setWorking(false);
    }
  }, [agentId, canCreate, cron, kind, message, minutes, reload, roomId, workspaceId]);

  const remove = useCallback(
    async (scheduleId: string) => {
      if (!roomId) return;
      setWorking(true);
      setError(null);
      try {
        await monolithPhoneOperation('deleteRoomSchedule', { roomId, scheduleId });
        setConfirmDelete(null);
        await reload();
      } catch (caught) {
        setError(`Could not delete schedule: ${String(caught)}`);
      } finally {
        setWorking(false);
      }
    },
    [reload, roomId],
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={styles.back}
        >
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Schedules</Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {roomName}
          </Text>
        </View>
      </View>
      {loading ? (
        <View style={styles.loading}>
          <PixelLoader />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.listSection} testID="schedule-list">
            <Text style={styles.sectionLabel}>ACTIVE SCHEDULES</Text>
            {schedules.length === 0 ? (
              <Text style={styles.empty}>No recurring Agent work in this Room.</Text>
            ) : (
              schedules.map((schedule) => {
                const confirming = confirmDelete === schedule.id;
                return (
                  <View
                    key={schedule.id}
                    style={styles.scheduleRow}
                    testID={`schedule-${schedule.id}`}
                  >
                    <Text style={styles.scheduleAgent}>
                      @{agentNames.get(schedule.agentId) ?? 'Agent'}
                    </Text>
                    <Text style={styles.scheduleMessage}>{schedule.message}</Text>
                    <Text style={styles.scheduleMeta}>{cadenceLabel(schedule.cadence)}</Text>
                    <Text style={styles.scheduleMeta}>
                      Next {NEXT_RUN.format(new Date(schedule.nextRunAt * 1_000))}
                    </Text>
                    <View style={styles.deleteRow}>
                      <TouchableOpacity
                        disabled={working}
                        onPress={() => setConfirmDelete(confirming ? null : schedule.id)}
                        style={styles.deleteAction}
                        testID={`delete-schedule-${schedule.id}`}
                      >
                        <Text style={styles.deleteText}>{confirming ? 'CANCEL' : 'DELETE'}</Text>
                      </TouchableOpacity>
                      {confirming && (
                        <TouchableOpacity
                          disabled={working}
                          onPress={() => void remove(schedule.id)}
                          style={styles.deleteAction}
                        >
                          <Text style={styles.confirmText}>CONFIRM DELETE</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })
            )}
          </View>

          <View style={styles.section} testID="schedule-add">
            <Text style={styles.sectionLabel}>ADD SCHEDULE</Text>
            <Text style={styles.fieldLabel}>AGENT</Text>
            <View style={styles.choiceRow}>
              {agents.map((agent) => (
                <TouchableOpacity
                  accessibilityState={{ selected: agent.id === agentId }}
                  key={agent.id}
                  onPress={() => setAgentId(agent.id)}
                  style={[styles.choice, agent.id === agentId && styles.choiceSelected]}
                >
                  <Text
                    style={[styles.choiceText, agent.id === agentId && styles.choiceTextSelected]}
                  >
                    @{agent.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {agents.length === 0 && (
              <Text style={styles.empty}>Add an Agent to this Room first.</Text>
            )}

            <Text style={styles.fieldLabel}>WHEN</Text>
            <View style={styles.choiceRow}>
              {(['interval', 'cron'] as const).map((value) => (
                <TouchableOpacity
                  accessibilityState={{ selected: kind === value }}
                  key={value}
                  onPress={() => setKind(value)}
                  style={[styles.choice, kind === value && styles.choiceSelected]}
                >
                  <Text style={[styles.choiceText, kind === value && styles.choiceTextSelected]}>
                    {value.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {kind === 'interval' ? (
              <TextInput
                accessibilityLabel="Interval in minutes"
                keyboardType="number-pad"
                onChangeText={setMinutes}
                placeholder="60"
                placeholderTextColor={theme.buzz.dim}
                style={styles.input}
                value={minutes}
              />
            ) : (
              <>
                <TextInput
                  accessibilityLabel="Cron expression in UTC"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setCron}
                  placeholder="0 9 * * 1-5"
                  placeholderTextColor={theme.buzz.dim}
                  style={styles.input}
                  value={cron}
                />
                <Text style={styles.hint}>Five-field cron expression · UTC</Text>
              </>
            )}
            <Text style={styles.fieldLabel}>MESSAGE</Text>
            <TextInput
              accessibilityLabel="Scheduled message"
              multiline
              onChangeText={setMessage}
              placeholder="What should the Agent do?"
              placeholderTextColor={theme.buzz.dim}
              style={[styles.input, styles.messageInput]}
              value={message}
            />
            <MonoButton
              disabled={!canCreate || working}
              label="Add schedule"
              loading={working}
              onPress={() => void create()}
              testID="add-room-schedule"
            />
          </View>
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
  container: { flex: 1, backgroundColor: groknight.bgTerminal },
  header: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
  },
  back: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  backText: { ...Typography.mono(), color: groknight.chrome, fontSize: 30 },
  title: { ...Typography.default('semiBold'), color: groknight.textPrimary, fontSize: 20 },
  subtitle: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 10,
    marginTop: 2,
    maxWidth: 260,
  },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 18 },
  section: {
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgBase,
    padding: 14,
    gap: 10,
  },
  listSection: { gap: 10 },
  sectionLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.chrome,
    fontSize: 11,
    letterSpacing: 1,
  },
  empty: { ...Typography.default(), color: groknight.textMuted, fontSize: 13, lineHeight: 19 },
  scheduleRow: { borderTopWidth: 1, borderTopColor: groknight.border, paddingTop: 12, gap: 4 },
  scheduleAgent: { ...Typography.mono('semiBold'), color: groknight.chrome, fontSize: 12 },
  scheduleMessage: {
    ...Typography.default(),
    color: groknight.textPrimary,
    fontSize: 15,
    lineHeight: 21,
  },
  scheduleMeta: { ...Typography.mono(), color: groknight.textMuted, fontSize: 10, lineHeight: 15 },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 20,
  },
  deleteAction: { minHeight: 44, justifyContent: 'center' },
  deleteText: { ...Typography.mono('semiBold'), color: groknight.textMuted, fontSize: 10 },
  confirmText: { ...Typography.mono('semiBold'), color: groknight.danger, fontSize: 10 },
  fieldLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 10,
    marginTop: 6,
  },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
  },
  choiceSelected: { backgroundColor: groknight.selection, borderColor: groknight.chrome },
  choiceText: { ...Typography.mono(), color: groknight.textMuted, fontSize: 11 },
  choiceTextSelected: { color: groknight.textPrimary },
  input: {
    ...Typography.mono(),
    minHeight: 48,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgTerminal,
    color: groknight.textPrimary,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  messageInput: { minHeight: 96, textAlignVertical: 'top' },
  hint: { ...Typography.default(), color: groknight.textMuted, fontSize: 11 },
  error: { ...Typography.mono(), color: groknight.danger, fontSize: 11, lineHeight: 17 },
}));
