import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as WebBrowser from 'expo-web-browser';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import {
  type ConnectorInstallState,
  type WorkbenchHelper,
} from '@/buzz/workbench';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const INSTALL_POLL_MS = 700;

/**
 * Connect Trusty Squire — the pairing flow (report §5, stories 1–2). Three
 * phases on one screen: pick the helper to pair (offline helpers are dimmed
 * and refuse), the helper's own step-by-step install reports (a failed step
 * turns red with the helper's reason and a Retry), and the sign-in button
 * that opens exactly the URL and method the server relays — the streamed
 * page in the in-app browser, an OAuth URL through the auth session.
 */
export default function ConnectTrustySquireScreen() {
  const params = useLocalSearchParams<{
    workspaceId?: string | string[];
    viewerId?: string | string[];
    connectorId?: string | string[];
  }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const viewerId = firstParam(params.viewerId) ?? '';
  const connectorId = firstParam(params.connectorId) ?? 'trusty-squire';
  const [helpers, setHelpers] = useState<readonly WorkbenchHelper[] | null>(null);
  const [install, setInstall] = useState<ConnectorInstallState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getWorkbenchSource()
      .listHelpers({ workspaceId })
      .then((result) => {
        if (!cancelled) setHelpers(result);
      })
      .catch(() => {
        if (!cancelled) setError('Helpers are unavailable right now');
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  const finishPolling = useCallback((state: ConnectorInstallState) => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (state.connected) {
      router.replace('/beeline/settings/workbench' as unknown as Href);
    }
  }, []);

  const startPolling = useCallback(
    (requestId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        void getWorkbenchSource()
          .readInstallState({ requestId })
          .then((state) => {
            if (!state) return;
            setInstall(state);
            if (state.connected || state.steps.some((step) => step.status === 'failed')) {
              finishPolling(state);
            }
          })
          .catch(() => undefined);
      }, INSTALL_POLL_MS);
    },
    [finishPolling],
  );

  const pair = useCallback(
    async (helper: WorkbenchHelper) => {
      setError(null);
      try {
        const { requestId } = await getWorkbenchSource().pairConnector({
          workspaceId,
          connectorId,
          helperId: helper.id,
          viewerId,
        });
        startPolling(requestId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Pairing failed');
      }
    },
    [connectorId, startPolling, viewerId, workspaceId],
  );

  const retry = useCallback(() => {
    setInstall(null);
  }, []);

  const signIn = useCallback(async (state: ConnectorInstallState) => {
    if (!state.signIn) return;
    if (state.signIn.method === 'oauth') {
      await WebBrowser.openAuthSessionAsync(state.signIn.url);
    } else {
      await WebBrowser.openBrowserAsync(state.signIn.url);
    }
  }, []);

  const connectorName = connectorId === 'trusty-squire' ? 'Trusty Squire' : connectorId;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="Back"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.backButton}
          testID="connect-back"
        >
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Connect {connectorName}</Text>
      </View>
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        {install === null ? (
          <View testID="connect-helper-picker">
            <Text style={styles.note}>
              Squire runs on a helper. Every agent on that helper can use its connections, within
              the grants you set.
            </Text>
            <Text style={styles.sectionLabel}>Helpers</Text>
            {(helpers ?? []).map((helper) => (
              <SettingsRow
                key={helper.id}
                description={
                  helper.online
                    ? `${helper.platform} · ${helper.agentCount} ${helper.agentCount === 1 ? 'agent' : 'agents'} · online`
                    : `${helper.platform} · offline`
                }
                disabled={!helper.online}
                onPress={() => void pair(helper)}
                testID={`connect-helper-${helper.id}`}
                title={helper.name}
                value={helper.online ? 'pair' : 'offline'}
              />
            ))}
            <Text style={styles.note}>Pair a helper, not an agent. Offline helpers cannot be paired.</Text>
          </View>
        ) : (
          <View testID="connect-install-progress">
            <View style={styles.steps}>
              {install.steps.map((step, index) => (
                <View key={`${step.label}-${index}`} testID={`connect-step-${index}-${step.status}`}>
                  <Text
                    style={[
                      styles.stepText,
                      step.status === 'done' && styles.stepDone,
                      step.status === 'active' && styles.stepActive,
                      step.status === 'failed' && styles.stepFailed,
                    ]}
                  >
                    {step.status === 'done'
                      ? `✓ ${step.label}`
                      : step.status === 'active'
                        ? `● ${step.label}`
                        : step.status === 'failed'
                          ? `✗ ${step.label}`
                          : `· ${step.label}`}
                  </Text>
                  {step.reason ? (
                    <Text style={styles.stepReason} testID={`connect-step-${index}-reason`}>
                      {step.reason}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
            {install.steps.some((step) => step.status === 'failed') ? (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={retry}
                style={styles.retryButton}
                testID="connect-retry"
              >
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            ) : install.signIn ? (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => void signIn(install)}
                style={styles.signInButton}
                testID="connect-sign-in"
              >
                <Text style={styles.signInText}>
                  Sign in to Squire · {install.signIn.method === 'oauth' ? 'OAuth' : 'streamed page'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}
        {error ? (
          <Text accessibilityRole="alert" style={styles.errorText} testID="connect-error">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    header: {
      minHeight: 66,
      paddingHorizontal: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backButtonText: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary, flex: 1 },
    content: { flex: 1 },
    contentInner: { padding: hull.space.md, gap: hull.layout.sectionGap, paddingBottom: hull.space.xxl },
    sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.textMuted },
    note: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    steps: { gap: hull.space.xs },
    stepText: { ...Typography.mono(), ...hull.type.meta, color: hull.textMuted },
    stepDone: { color: hull.textSecondary },
    stepActive: { color: hull.accent },
    stepFailed: { color: hull.dialogDanger },
    stepReason: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger },
    signInButton: {
      minHeight: hull.layout.row,
      borderWidth: 1,
      borderColor: hull.accent,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: hull.space.md,
    },
    signInText: { ...Typography.default(), ...hull.type.body, color: hull.accent },
    retryButton: {
      minHeight: hull.layout.row,
      borderWidth: 1,
      borderColor: hull.border,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: hull.space.md,
    },
    retryText: { ...Typography.default(), ...hull.type.body, color: hull.textMuted },
    errorText: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger },
  };
});
