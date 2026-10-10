import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import {
  stopWebhook,
  useScheduledWork,
  webhookPayload,
  webhookRuns,
  webhookTrigger,
} from '@/buzz/scheduled-work';
import { PageHeader } from '@/components/buzz/PageHeader';
import {
  DetailCopy,
  DetailRailLine,
  DetailSection,
  ScheduledWorkFacts,
  StopScheduledWork,
} from '@/components/buzz/ScheduledWorkDetail';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * One webhook, laid out like a workflow run page and its schedule siblings:
 * the Runs, Agents and Where rows, then what makes it fire (its source, its
 * signing, and the reason the requesting agent gave), what a delivery does,
 * then Stop. It keeps no delivery log: bare timestamps say nothing.
 */
export default function Webhook() {
  useLatencyRouteFrame('/beeline/settings/webhook');
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    roomId?: string | string[];
    webhookId?: string | string[];
  }>();
  const roomId = first(params.roomId);
  const webhookId = first(params.webhookId);
  const { work, loading, error, setError, retry } = useScheduledWork(roomId);
  useLatencyRouteFrame('/beeline/settings/webhook', !loading, true);
  const [working, setWorking] = useState(false);
  const hook = work?.webhooks.find((candidate) => candidate.id === webhookId);

  const stop = async () => {
    if (!roomId || !hook) return;
    setWorking(true);
    try {
      await stopWebhook(roomId, hook.id);
      router.back();
    } catch (caught) {
      setError(`Could not stop the webhook: ${String(caught)}`);
    } finally {
      setWorking(false);
    }
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <PageHeader
        backAccessibilityLabel="Back to Schedules and Webhooks"
        eyebrow="Schedules and Webhooks"
        onBack={() => router.back()}
        testID="webhook-header"
        title={hook ? `${hook.source} webhook` : 'Webhook'}
      />
      {error && (
        <Pressable accessibilityRole="alert" onPress={retry} style={styles.error}>
          <Text style={styles.errorText}>{error} · Retry</Text>
        </Pressable>
      )}
      {loading && !work ? (
        <View style={styles.loading}>
          <SurfaceGlyphLoader testID="webhook-loader" />
        </View>
      ) : hook ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
          testID="webhook-page"
        >
          <ScheduledWorkFacts agents={hook.agents} runs={webhookRuns(hook)} where="this Room" />
          <DetailSection testID="webhook-trigger-header" title="Trigger" />
          <DetailCopy testID="webhook-trigger">{webhookTrigger(hook)}</DetailCopy>
          {hook.reason ? (
            <DetailRailLine testID="webhook-reason">
              {`Why: "${hook.reason}"`}
              {hook.requestedBy ? ` @${hook.requestedBy}` : ''}
            </DetailRailLine>
          ) : null}
          <DetailSection testID="webhook-payload-header" title="Payload" />
          <DetailCopy testID="webhook-payload">{webhookPayload(hook)}</DetailCopy>
          <View style={styles.stop}>
            <StopScheduledWork
              label="Stop webhook"
              onStop={() => void stop()}
              testID="stop-webhook"
              working={working}
            />
          </View>
        </ScrollView>
      ) : work ? (
        <Text style={styles.gone} testID="webhook-gone">
          This webhook has stopped.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  loading: { padding: theme.buzz.space.xl, alignItems: 'center', justifyContent: 'center' },
  stop: { marginTop: theme.buzz.space.md },
  gone: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary, padding: theme.buzz.space.md },
  error: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.buzz.space.md,
    backgroundColor: theme.buzz.bgHighlight,
  },
  errorText: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
}));
