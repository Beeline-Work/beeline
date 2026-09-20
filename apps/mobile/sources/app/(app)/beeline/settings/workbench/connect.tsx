import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HullSurface } from '@/components/buzz/MonoHull';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { PulsingText } from '@/components/buzz/PulsingText';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { connectorOfferCompletionRoute } from '@/buzz/connector-offer-ceremony';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { type ConnectorInstallState, type WorkbenchHelper } from '@/buzz/workbench';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** User-visible connector names, one row per id the build knows. `google` is
 * the ONE logical Google entry — the four tool connectors behind one grant. */
const CONNECTOR_NAMES: Record<string, string> = {
  'trusty-squire': 'Trusty Squire',
  google: 'Google Workspace',
  'google-gmail': 'Gmail',
  'google-calendar': 'Google Calendar',
  'google-drive': 'Google Drive',
  'google-youtube': 'YouTube',
};

function connectorNameFor(connectorId: string): string {
  return CONNECTOR_NAMES[connectorId] ?? connectorId;
}

const INSTALL_POLL_MS = 700;
/** Consecutive failed/missing install reads before the poll reports a loss
 *  through `connect-error` instead of spinning silently on the picker. */
const INSTALL_POLL_MISS_LIMIT = 8;
/** Bounded feedback for a pair POST that never settles: the transport sets
 *  no timeout of its own, so a hung await must still reach the user. */
const PAIR_FEEDBACK_MS = 15_000;

/**
 * Connect Trusty Squire — the pairing flow. ONE connect path (captain
 * ruling, steer-1): pairing asks once. The helper-machine selector is
 * ALWAYS shown before the binary install starts — one machine or many —
 * so the user explicitly targets the machine that will hold the keys
 * (steer: multi-agent, multi-machine setups). The helper's own step
 * reports follow as a live checklist: the running step pulses gold, the
 * CLI command and its captured output stream under it, done steps check
 * off, and a failed step shows its own reason and output with a Retry —
 * never a silent hang. Sign-in is an in-app browser overlay route, never
 * a row inside the step list.
 */
export default function ConnectTrustySquireScreen() {
  const params = useLocalSearchParams<{
    workspaceId?: string | string[];
    viewerId?: string | string[];
    connectorId?: string | string[];
    pairedConnectorId?: string | string[];
    offerId?: string | string[];
    roomId?: string | string[];
  }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const viewerId = firstParam(params.viewerId) ?? '';
  const connectorId = firstParam(params.connectorId) ?? 'trusty-squire';
  const pairedConnectorId = firstParam(params.pairedConnectorId);
  const offerId = firstParam(params.offerId);
  const roomId = firstParam(params.roomId);
  const offerCeremony = Boolean(offerId && pairedConnectorId && roomId);
  const [helpers, setHelpers] = useState<readonly WorkbenchHelper[] | null>(null);
  const [install, setInstall] = useState<ConnectorInstallState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pairedHelperRef = useRef<string | null>(null);

  useEffect(() => {
    if (offerCeremony) return;
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
  }, [offerCeremony, workspaceId]);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const finishPolling = useCallback(
    (state: ConnectorInstallState) => {
      stopPolling();
      if (state.connected) {
        router.replace(connectorOfferCompletionRoute(roomId) as unknown as Href);
      }
    },
    [roomId, stopPolling],
  );

  const startPolling = useCallback(
    (pairedConnectorId: string) => {
      stopPolling();
      let misses = 0;
      pollRef.current = setInterval(() => {
        void getWorkbenchSource()
          .readInstallState({ connectorId: pairedConnectorId, workspaceId })
          .then((state) => {
            if (!state) {
              // The paired row vanished (unpaired/reset server-side): a
              // bounded miss count surfaces it, never a silent stall.
              misses += 1;
              if (misses >= INSTALL_POLL_MISS_LIMIT) {
                stopPolling();
                setError('Lost track of the install — pair the machine again');
              }
              return;
            }
            misses = 0;
            setInstall(state);
            if (state.connected || state.steps.some((step) => step.status === 'failed')) {
              finishPolling(state);
            }
          })
          .catch(() => {
            misses += 1;
            if (misses >= INSTALL_POLL_MISS_LIMIT) {
              stopPolling();
              setError('Lost contact while installing — check the helper and pair again');
            }
          });
      }, INSTALL_POLL_MS);
    },
    [finishPolling, stopPolling, workspaceId],
  );

  useEffect(() => {
    if (pairedConnectorId) startPolling(pairedConnectorId);
  }, [pairedConnectorId, startPolling]);

  const pair = useCallback(
    async (helperId: string) => {
      stopPolling();
      setError(null);
      pairedHelperRef.current = helperId;
      // The pair POST has no transport timeout; if it never settles, say so
      // while the await continues — a late resolve still starts the poll.
      let feedbackShown = false;
      const feedback = setTimeout(() => {
        feedbackShown = true;
        setError('Still pairing — the helper is not answering');
      }, PAIR_FEEDBACK_MS);
      try {
        const { connectorId: pairedConnectorId } = await getWorkbenchSource().pairConnector({
          workspaceId,
          connectorId,
          helperId,
        });
        if (feedbackShown) setError(null);
        startPolling(pairedConnectorId);
      } catch (cause) {
        if (!feedbackShown) {
          setError(cause instanceof Error ? cause.message : 'Pairing failed');
        }
      } finally {
        clearTimeout(feedback);
      }
    },
    [connectorId, startPolling, stopPolling, workspaceId],
  );

  const retry = useCallback(() => {
    setInstall(null);
    if (offerId) {
      void monolithPhoneOperation('acceptConnectorOffer', { offerId })
        .then((accepted) => startPolling(accepted.connectorId))
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : 'Pairing failed');
        });
      return;
    }
    const helperId = pairedHelperRef.current;
    if (helperId) void pair(helperId);
  }, [offerId, pair, startPolling]);

  const connectorName = connectorNameFor(connectorId);

  const noHelpers = helpers !== null && helpers.length === 0;
  // The machine selector is explicit BEFORE any install: the user targets
  // the helper machine, whether the workspace runs one helper or many.
  const someHelpers = helpers !== null && helpers.length > 0;

  return (
    <View style={styles.container}>
      <HullSurface strength="quiet" style={[styles.header, { paddingTop: insets.top }]}>
        <TouchableOpacity
          accessibilityLabel="Back"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.backButton}
          testID="connect-back"
        >
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Connect {connectorName}</Text>
        </View>
      </HullSurface>
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        {helpers === null && !offerCeremony ? (
          <View style={styles.loading} testID="connect-loading">
            <SurfaceGlyphLoader testID="connect-loader" />
            <Text style={styles.note}>Looking for your machine…</Text>
          </View>
        ) : null}
        {noHelpers && !offerCeremony ? (
          <View testID="connect-no-helper">
            <Text style={styles.note}>
              Squire runs on a helper. Every agent on that helper can use its connections, within
              the grants you set.
            </Text>
            <Text style={styles.empty} testID="connect-no-helper-empty">
              No helpers found
            </Text>
            <View style={styles.commandBlock} testID="connect-no-helper-command">
              <Text style={styles.command}>npx usebeeline connect</Text>
              <Text style={styles.note}>
                Run this on the machine you want to hold your keys. When it appears here, come back
                and pair it.
              </Text>
            </View>
          </View>
        ) : null}
        {install === null && offerCeremony ? (
          <View style={styles.loading} testID="connect-offer-loading">
            <SurfaceGlyphLoader testID="connect-offer-loader" />
            <Text style={styles.note}>Starting sign-in on the offered helper…</Text>
          </View>
        ) : null}
        {install === null && someHelpers && !offerCeremony ? (
          <View testID="connect-machine-picker">
            <Text style={styles.sectionLabel}>Helpers</Text>
            {helpers!.map((helper) => (
              <SettingsRow
                key={helper.id}
                description={helper.online ? 'online' : 'offline'}
                disabled={!helper.online}
                onPress={() => void pair(helper.id)}
                testID={`connect-machine-${helper.id}`}
                title={helper.name}
                action={helper.online ? 'pair' : undefined}
                value={helper.online ? undefined : 'offline'}
              />
            ))}
            <Text style={styles.note}>
              Pair a helper, not an agent. Offline helpers cannot be paired.
            </Text>
          </View>
        ) : null}
        {install !== null ? (
          <View testID="connect-install-progress">
            <Text style={styles.note}>Installing on {install.helperName ?? 'your machine'}</Text>
            <View style={styles.steps}>
              {install.steps.map((step, index) => (
                <View
                  key={`${step.label}-${index}`}
                  testID={`connect-step-${index}-${step.status}`}
                >
                  {step.status === 'active' ? (
                    <PulsingText style={[styles.stepText, styles.stepActive]}>
                      ● {step.label}
                    </PulsingText>
                  ) : (
                    <Text
                      style={[
                        styles.stepText,
                        step.status === 'done' && styles.stepDone,
                        step.status === 'failed' && styles.stepFailed,
                      ]}
                    >
                      {step.status === 'done'
                        ? `✓ ${step.label}`
                        : step.status === 'failed'
                          ? `✗ ${step.label}`
                          : `· ${step.label}`}
                    </Text>
                  )}
                  {step.command ? (
                    <Text style={styles.stepCommand} testID={`connect-step-${index}-command`}>
                      $ {step.command}
                    </Text>
                  ) : null}
                  {step.output ? (
                    <Text style={styles.stepOutput} testID={`connect-step-${index}-output`}>
                      {step.output}
                    </Text>
                  ) : null}
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
                onPress={() => {
                  const { signIn } = install;
                  if (!signIn) return;
                  router.push({
                    pathname: '/beeline/settings/workbench/connect-signin' as never,
                    params: {
                      workspaceId,
                      viewerId,
                      // The paired ROW id, so the overlay polls this
                      // machine's connector — not any row of the type.
                      connectorId: install.connectorId,
                      url: signIn.url,
                      method: signIn.method,
                      ...(offerId ? { offerId } : {}),
                      ...(roomId ? { roomId } : {}),
                    },
                  });
                }}
                style={styles.signInButton}
                testID="connect-sign-in"
              >
                <Text style={styles.signInText}>Sign in to Squire</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
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
    headerCopy: { flex: 1, minWidth: 0 },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    content: { flex: 1 },
    contentInner: {
      padding: hull.space.md,
      gap: hull.layout.sectionGap,
      paddingBottom: hull.space.xxl,
    },
    loading: { alignItems: 'center', gap: hull.space.sm, paddingVertical: hull.space.xl },
    sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.textMuted },
    note: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    // The empty state's one centered fact (board: `emp`).
    empty: {
      ...Typography.default(),
      ...hull.type.body,
      color: hull.textPrimary,
      textAlign: 'center',
      paddingVertical: hull.space.md,
    },
    // The one raised block: the CLI command the user must run, boxed because
    // it is the one thing the page asks them to act on.
    commandBlock: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      borderRadius: hull.radius,
      padding: hull.space.md,
      gap: hull.space.sm,
    },
    command: { ...Typography.mono(), ...hull.type.body, color: hull.textPrimary },
    steps: { gap: hull.space.xs },
    stepText: { ...Typography.mono(), ...hull.type.meta, color: hull.textMuted },
    stepDone: { color: hull.textSecondary },
    stepActive: { color: hull.accent },
    stepFailed: { color: hull.dialogDanger },
    stepCommand: {
      ...Typography.mono(),
      ...hull.type.meta,
      color: hull.textMuted,
      marginTop: 2,
    },
    stepOutput: {
      ...Typography.mono(),
      ...hull.type.meta,
      color: hull.textSecondary,
      opacity: 0.85,
      marginTop: 2,
    },
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
