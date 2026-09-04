import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomScheduleCadence, RoomScheduleView } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import { PixelLoader } from '@/components/buzz/MonoHull';
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

const NEXT_RUN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Agents control recurring work. Room managers can only inspect or stop it. */
export default function ScheduledWork() {
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
      const listed = await monolithPhoneOperation('listRoomSchedules', { roomId });
      setRoomName(room.room.name);
      setAgents(
        room.members
          .filter((member) => member.identity.kind === 'agent')
          .map((member) => ({ id: member.identity.pubkey, name: member.identity.name })),
      );
      setSchedules(listed.schedules);
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

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      {/* The stack header owns the title and the only back control (C75). */}
      <View style={styles.header}>
        <Text numberOfLines={1} style={styles.subtitle} testID="scheduled-work-room">
          {roomName}
        </Text>
      </View>
      {loading ? (
        <View style={styles.loading}>
          <PixelLoader />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.listSection} testID="scheduled-work-list">
            <Text style={styles.sectionLabel}>AGENT-MANAGED SCHEDULES</Text>
            <Text style={styles.notice}>
              Scheduled work appears with this Room&apos;s repository notifications. Agents create
              it; managers can stop it.
            </Text>
            {schedules.length === 0 ? (
              <Text style={styles.empty}>No scheduled Agent work in this Room.</Text>
            ) : (
              schedules.map((schedule) => {
                const confirming = confirmStop === schedule.id;
                return (
                  <View
                    key={schedule.id}
                    style={styles.scheduleRow}
                    testID={`scheduled-work-${schedule.id}`}
                  >
                    <Text style={styles.scheduleAgent}>
                      @{agentNames.get(schedule.agentId) ?? 'Agent'}
                    </Text>
                    <Text style={styles.scheduleMessage}>{schedule.message}</Text>
                    <Text style={styles.scheduleMeta}>{cadenceLabel(schedule.cadence)}</Text>
                    <Text style={styles.scheduleMeta}>
                      Next {NEXT_RUN.format(new Date(schedule.nextRunAt * 1_000))}
                    </Text>
                    <View style={styles.stopRow}>
                      <TouchableOpacity
                        disabled={working}
                        onPress={() => setConfirmStop(confirming ? null : schedule.id)}
                        style={styles.stopAction}
                        testID={`stop-scheduled-work-${schedule.id}`}
                      >
                        <Text style={styles.stopText}>{confirming ? 'CANCEL' : 'STOP'}</Text>
                      </TouchableOpacity>
                      {confirming && (
                        <TouchableOpacity
                          disabled={working}
                          onPress={() => void stop(schedule.id)}
                          style={styles.stopAction}
                        >
                          <Text style={styles.confirmText}>CONFIRM STOP</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })
            )}
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

const styles = StyleSheet.create(() => ({
  container: { flex: 1, backgroundColor: groknight.bgTerminal },
  header: { paddingHorizontal: 16, paddingTop: 8 },
  subtitle: { ...Typography.mono(), color: groknight.textMuted, fontSize: 10 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 18 },
  listSection: { gap: 10 },
  sectionLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.chrome,
    fontSize: 11,
    letterSpacing: 1,
  },
  notice: { ...Typography.default(), color: groknight.textMuted, fontSize: 13, lineHeight: 19 },
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
  stopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 20 },
  stopAction: { minHeight: 44, justifyContent: 'center' },
  stopText: { ...Typography.mono('semiBold'), color: groknight.textMuted, fontSize: 10 },
  confirmText: { ...Typography.mono('semiBold'), color: groknight.danger, fontSize: 10 },
  error: { ...Typography.mono(), color: groknight.danger, fontSize: 11, lineHeight: 17 },
}));
