import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { scheduleRuns, scheduleWhere, stopSchedule, useScheduledWork } from '@/buzz/scheduled-work';
import { PageHeader } from '@/components/buzz/PageHeader';
import {
  ScheduledWorkDoes,
  ScheduledWorkFacts,
  StopScheduledWork,
} from '@/components/buzz/ScheduledWorkDetail';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * One schedule, with the same detail grammar as a subscription.
 */
export default function PromptSchedule() {
  useLatencyRouteFrame('/beeline/settings/schedule');
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    roomId?: string | string[];
    scheduleId?: string | string[];
  }>();
  const roomId = first(params.roomId);
  const scheduleId = first(params.scheduleId);
  const { work, loading, error, setError, retry } = useScheduledWork(roomId);
  useLatencyRouteFrame('/beeline/settings/schedule', !loading, true);
  const [working, setWorking] = useState(false);
  const schedule = work?.schedules.find((candidate) => candidate.id === scheduleId);

  const stop = async () => {
    if (!roomId || !schedule) return;
    setWorking(true);
    try {
      await stopSchedule(roomId, schedule.id);
      router.back();
    } catch (caught) {
      setError(`Could not stop the schedule: ${String(caught)}`);
    } finally {
      setWorking(false);
    }
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <PageHeader
        backAccessibilityLabel="Back to Schedules and subscriptions"
        eyebrow="Schedules and subscriptions"
        onBack={() => router.back()}
        testID="schedule-header"
        title="Schedule"
      />
      {error && (
        <Pressable accessibilityRole="alert" onPress={retry} style={styles.error}>
          <Text style={styles.errorText}>{error} · Retry</Text>
        </Pressable>
      )}
      {loading && !work ? (
        <View style={styles.loading}>
          <SurfaceGlyphLoader testID="schedule-loader" />
        </View>
      ) : schedule ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
          testID="schedule-page"
        >
          <ScheduledWorkFacts
            agents={[work?.agentNames.get(schedule.agentId) ?? 'Agent']}
            runs={scheduleRuns(schedule)}
            where={scheduleWhere(schedule, work?.roomName)}
            whereCorner={schedule.corner}
          />
          <ScheduledWorkDoes roomId={schedule.roomId}
            prompt={schedule.message} workflowSlug={schedule.workflowSlug} />
          <StopScheduledWork
            label="Stop schedule"
            onStop={() => void stop()}
            testID="stop-schedule"
            working={working}
          />
        </ScrollView>
      ) : work ? (
        <Text style={styles.gone} testID="schedule-gone">
          This schedule has stopped.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  loading: { padding: theme.buzz.space.xl, alignItems: 'center', justifyContent: 'center' },
  gone: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary, padding: theme.buzz.space.md },
  error: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.buzz.space.md,
    backgroundColor: theme.buzz.bgHighlight,
  },
  errorText: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
}));
