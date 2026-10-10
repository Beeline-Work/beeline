import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import {
  stopSubscription,
  subscriptionRuns,
  subscriptionSource,
  subscriptionWhere,
  useScheduledWork,
} from '@/buzz/scheduled-work';
import { PageHeader } from '@/components/buzz/PageHeader';
import { DetailCopy, DetailSection, ScheduledWorkFacts, StopScheduledWork } from '@/components/buzz/ScheduledWorkDetail';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The event and source that wake one agent, with the same stop control as a schedule. */
export default function Subscription() {
  useLatencyRouteFrame('/beeline/settings/subscription');
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ roomId?: string | string[]; subscriptionId?: string | string[] }>();
  const roomId = first(params.roomId);
  const subscriptionId = first(params.subscriptionId);
  const { work, loading, error, setError, retry } = useScheduledWork(roomId);
  useLatencyRouteFrame('/beeline/settings/subscription', !loading, true);
  const [working, setWorking] = useState(false);
  const subscription = work?.subscriptions.find((candidate) => candidate.id === subscriptionId);

  const stop = async () => {
    if (!roomId || !subscription) return;
    setWorking(true);
    try {
      await stopSubscription(roomId, subscription.id);
      router.back();
    } catch (caught) {
      setError(`Could not stop the subscription: ${String(caught)}`);
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
        testID="subscription-header"
        title="Subscription"
      />
      {error && (
        <Pressable accessibilityRole="alert" onPress={retry} style={styles.error}>
          <Text style={styles.errorText}>{error} · Retry</Text>
        </Pressable>
      )}
      {loading && !work ? (
        <View style={styles.loading}><SurfaceGlyphLoader testID="subscription-loader" /></View>
      ) : subscription ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 24 + insets.bottom }} testID="subscription-page">
          <ScheduledWorkFacts
            agents={[work?.agentNames.get(subscription.agentId) ?? 'Agent']}
            runs={subscriptionRuns(subscription)}
            where={subscriptionWhere(subscription)}
          />
          <DetailSection testID="subscription-trigger-header" title="Trigger" />
          <DetailCopy testID="subscription-trigger">
            {`${subscription.event} from ${subscriptionSource(subscription)}.`}
          </DetailCopy>
          <DetailSection testID="subscription-payload-header" title="Event" />
          <DetailCopy testID="subscription-payload">
            When this event arrives, the agent wakes with its details.
          </DetailCopy>
          <View style={styles.stop}>
            <StopScheduledWork
              label="Stop subscription"
              onStop={() => void stop()}
              testID="stop-subscription"
              working={working}
            />
          </View>
        </ScrollView>
      ) : work ? (
        <Text style={styles.gone} testID="subscription-gone">This subscription has stopped.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  loading: { padding: theme.buzz.space.xl, alignItems: 'center', justifyContent: 'center' },
  stop: { marginTop: theme.buzz.space.md },
  gone: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary, padding: theme.buzz.space.md },
  error: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.buzz.space.md, backgroundColor: theme.buzz.bgHighlight },
  errorText: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
}));
