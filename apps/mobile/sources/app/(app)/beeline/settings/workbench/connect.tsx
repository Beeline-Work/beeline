import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { PulsingText } from '@/components/buzz/PulsingText';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { useInstallObserver } from '@/buzz/use-observed-resource';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { connectorOfferCompletionRoute } from '@/buzz/connector-offer-ceremony';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import {
  connectorSignInLocationLine,
  type ConnectorInstallState,
  type WorkbenchHelper,
} from '@/buzz/workbench';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** User-visible names for the remaining machine-level tool pairing flow. */
const CONNECTOR_NAMES: Record<string, string> = {
  'trusty-squire': 'Trusty Squire',
  tailscale: 'Tailscale',
};

function connectorNameFor(connectorId: string): string {
  return CONNECTOR_NAMES[connectorId] ?? connectorId;
}

/** Bounded feedback for a pair POST that never settles: the transport sets
 *  no timeout of its own, so a hung await must still reach the user. */
const PAIR_FEEDBACK_MS = 15_000;

/**
 * Connect Trusty Squire — one page for pairing and installation. One
 * eligible online helper pairs automatically; several require a choice.
 * The chosen helper stays visible above the helper's own step
 * reports follow as a live checklist: the running step pulses gold, the
 * CLI command and its captured output stream under it, done steps check
 * off, and a failed step shows its own reason and output with a Retry —
 * never a silent hang. Sign-in is an in-app browser overlay route, never
 * a row inside the step list.
 */
export default function ConnectTrustySquireScreen() {
  const params = useLocalSearchParams<{ connectorId?: string | string[];
    workspaceId?: string | string[]; viewerId?: string | string[] }>();
  const connectorId = firstParam(params.connectorId);
  if (connectorId === 'google' || connectorId?.startsWith('google-'))
    return <LegacyGoogleAppRedirect workspaceId={firstParam(params.workspaceId) ?? ''}
      viewerId={firstParam(params.viewerId) ?? ''} />;
  return <ConnectToolFlow />;
}

function LegacyGoogleAppRedirect({ workspaceId, viewerId }: { workspaceId: string; viewerId: string }) {
  useEffect(() => { router.replace({ pathname: '/beeline/settings/workbench/connect-app',
    params: { workspaceId, viewerId } } as Href); }, [workspaceId, viewerId]);
  return null;
}

function ConnectToolFlow() {
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
  const [selectedHelperName, setSelectedHelperName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [observedId, setObservedId] = useState(pairedConnectorId);
  const observed = useInstallObserver(workspaceId, observedId);
  useEffect(() => { if (pairedConnectorId) setObservedId(pairedConnectorId); }, [pairedConnectorId]);
  const pairedHelperRef = useRef<string | null>(null);
  const autoPairRef = useRef(false);

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

  const stopPolling = useCallback(() => setObservedId(undefined), []);
  const startPolling = useCallback((id: string) => {
    setObservedId(id);
    if (id === observedId) observed.retry();
  }, [observedId, observed.retry]);
  useEffect(() => {
    if (observed.data) {
      setInstall(observed.data);
      if (observed.data.connected) router.replace(connectorOfferCompletionRoute(roomId) as Href);
    }
  }, [observed.data, roomId]);
  useEffect(() => { if (observed.error) setError(observed.error); }, [observed.error]);

  const pair = useCallback(
    async (helperId: string) => {
      stopPolling();
      setError(null);
      pairedHelperRef.current = helperId;
      setSelectedHelperName(helpers?.find((helper) => helper.id === helperId)?.name ?? null);
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
    [connectorId, helpers, startPolling, stopPolling, workspaceId],
  );

  useEffect(() => {
    if (offerCeremony || autoPairRef.current || helpers === null || pairedHelperRef.current) return;
    const online = helpers.filter((helper) => helper.online);
    if (online.length !== 1) return;
    autoPairRef.current = true;
    void pair(online[0]!.id);
  }, [helpers, offerCeremony, pair]);

  const retry = useCallback(() => {
    setError(null);
    if (observed.error && !observed.installMissing) {
      void observed.retry();
      return;
    }
    stopPolling();
    setInstall(null);
    if (offerId) {
      void monolithPhoneOperation('acceptConnectorOffer', { offerId })
        .then((accepted) => {
          if (accepted.status !== 'accepted') startPolling(accepted.connectorId);
        })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : 'Pairing failed');
        });
      return;
    }
    const helperId = pairedHelperRef.current;
    if (helperId) void pair(helperId);
  }, [observed.error, observed.installMissing, observed.retry, offerId, pair, startPolling, stopPolling]);

  const connectorName = connectorNameFor(connectorId);
  const machineName = install?.helperName ?? selectedHelperName;

  const noHelpers = helpers !== null && helpers.every((helper) => !helper.online);
  // Only online helpers are eligible. A sole eligible machine has no choice
  // to make; the helper row still stays visible above installation output.
  const onlineHelpers = helpers?.filter((helper) => helper.online) ?? [];
  const someHelpers = onlineHelpers.length > 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <PageHeader
        backAccessibilityLabel="Back to Workbench"
        eyebrow="Workbench"
        prominent
        onBack={() => router.back()}
        testID="connect-header"
        title={connectorName}
      />
      <ScrollView
        style={styles.content}
        contentContainerStyle={[styles.contentInner, { paddingBottom: theme.buzz.space.xxl + insets.bottom }]}
        testID="connect-scroll"
      >
        {helpers === null && !offerCeremony ? (
          <View style={styles.loading} testID="connect-loading">
            <SurfaceGlyphLoader testID="connect-loader" />
            <Text style={styles.note}>Looking for your machine…</Text>
          </View>
        ) : null}
        {noHelpers && !offerCeremony ? (
          <View testID="connect-no-helper">
            <Text style={styles.note}>
              Squire runs on a helper. Every agent on that helper can use its connections, within the grants you set.
            </Text>
            <Text style={styles.empty} testID="connect-no-helper-empty">
              No online helpers found
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
        {someHelpers && !offerCeremony ? (
          <View testID="connect-machine-picker">
            <Text style={styles.sectionLabel}>Helpers</Text>
            {onlineHelpers.length === 1 ? (
              <SettingsRow title={onlineHelpers[0]!.name}
                description={install ? 'paired' : 'pairing automatically'}
                testID={`connect-machine-${onlineHelpers[0]!.id}`} />
            ) : onlineHelpers.map((helper) => (
              <SettingsRow
                key={helper.id}
                description={pairedHelperRef.current === helper.id ? 'paired' : 'online'}
                disabled={Boolean(pairedHelperRef.current)}
                onPress={() => void pair(helper.id)}
                testID={`connect-machine-${helper.id}`}
                title={helper.name}
                action={pairedHelperRef.current ? undefined : 'pair'}
              />
            ))}
            {onlineHelpers.length > 1 && !pairedHelperRef.current ?
              <Text style={styles.note}>Choose the machine that will hold your keys.</Text> : null}
          </View>
        ) : null}
        {install !== null ? (
          <View testID="connect-install-progress">
            <Text style={styles.note}>Installing on {machineName ?? 'your machine'}</Text>
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
              <View style={styles.signInBlock}>
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
                        connectorName,
                        ...(machineName ? { machineName } : {}),
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
                  <Text style={styles.signInText}>Sign in to {connectorName}</Text>
                </TouchableOpacity>
                {connectorSignInLocationLine(install.signIn.browserLocation) ? (
                  <Text style={styles.signInLocation} testID="connect-sign-in-location">
                    {connectorSignInLocationLine(install.signIn.browserLocation)}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
        {error ? (
          <View>
            <Text accessibilityRole="alert" style={styles.errorText} testID="connect-error">
              {error}
            </Text>
            {pairedHelperRef.current || observedId ? <TouchableOpacity accessibilityRole="button"
              onPress={retry} style={styles.retryButton} testID="connect-pair-retry">
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity> : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
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
      borderColor: hull.buttonSecondaryText,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: hull.space.md,
    },
    signInBlock: { gap: hull.space.xs },
    signInLocation: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      textAlign: 'center',
    },
    signInText: { ...Typography.default(), ...hull.type.body, color: hull.buttonSecondaryText },
    retryButton: {
      minHeight: hull.layout.row,
      borderWidth: 1,
      borderColor: hull.buttonSecondaryText,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: hull.space.md,
    },
    retryText: { ...Typography.default(), ...hull.type.body, color: hull.buttonSecondaryText },
    errorText: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger },
  };
});
