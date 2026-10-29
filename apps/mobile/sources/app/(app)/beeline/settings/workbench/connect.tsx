import { appErrorCopy } from '@/buzz/app-error-copy';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/buzz/Button';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { useInstallObserver } from '@/buzz/use-observed-resource';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { connectorOfferCompletionRoute } from '@/buzz/connector-offer-ceremony';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import {
  connectorSignInLocationLine,
  isSquireStageLabel,
  squirePairingStages,
  type ConnectorInstallState,
  type ConnectorInstallStep,
} from '@/buzz/workbench';
import { WorkflowStepCircle } from '@/components/buzz/WorkflowRunLine';

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

type InstallStage = {
  key?: string;
  label: string;
  status: 'done' | 'current' | 'pending' | 'failed';
  reason?: string;
  command?: string;
  output?: string;
};

/** Any other connector's own steps: the running (or first unfinished) one is current. */
function genericInstallStages(steps: readonly ConnectorInstallStep[]): InstallStage[] {
  const failed = steps.some((step) => step.status === 'failed');
  const active = steps.some((step) => step.status === 'active');
  let current = failed || active;
  return steps.map((step) => {
    const status = step.status === 'active' ? 'current' as const
      : step.status === 'pending' && !current ? (current = true, 'current' as const)
        : step.status;
    return { ...step, status };
  });
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
  useLatencyRouteFrame('/beeline/settings/workbench/connect');
  const params = useLocalSearchParams<{ connectorId?: string | string[];
    workspaceId?: string | string[]; viewerId?: string | string[] }>();
  const connectorId = firstParam(params.connectorId);
  if (connectorId === 'google' || connectorId?.startsWith('google-'))
    return (
      <LegacyGoogleAppRedirect workspaceId={firstParam(params.workspaceId) ?? ''}
      viewerId={firstParam(params.viewerId) ?? ''} />);
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
    helperId?: string | string[];
  }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const viewerId = firstParam(params.viewerId) ?? '';
  const connectorId = firstParam(params.connectorId) ?? 'trusty-squire';
  const pairedConnectorId = firstParam(params.pairedConnectorId);
  const offerId = firstParam(params.offerId);
  const roomId = firstParam(params.roomId);
  const requestedHelperId = firstParam(params.helperId);
  const offerCeremony = Boolean(offerId && pairedConnectorId && roomId);
  const { value: workbench, error: helperLoadError } = useSharedWorkbench(
    offerCeremony ? null : { workspaceId, viewerId });
  const helpers = workbench?.helpers ?? null;
  const [install, setInstall] = useState<ConnectorInstallState | null>(null);
  const [selectedHelperName, setSelectedHelperName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const desktopPageLayout = useDesktopPageLayout();
  const [observedId, setObservedId] = useState(pairedConnectorId);
  const observed = useInstallObserver(workspaceId, observedId);
  useEffect(() => { if (pairedConnectorId) setObservedId(pairedConnectorId); }, [pairedConnectorId]);
  const pairedHelperRef = useRef<string | null>(pairedConnectorId?.startsWith('squire:') ? pairedConnectorId.slice(7) : null);
  const autoPairRef = useRef(false);

  const stopObserving = useCallback(() => setObservedId(undefined), []);
  const startObserving = useCallback((id: string) => {
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
      stopObserving();
      setError(null);
      pairedHelperRef.current = helperId;
      setSelectedHelperName(helpers?.find((helper) => helper.id === helperId)?.name ?? null);
      // The pair POST has no transport timeout; if it never settles, say so
      // while the await continues — a late resolve still starts the observer.
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
        startObserving(pairedConnectorId);
      } catch (cause) {
        if (!feedbackShown) {
          setError(appErrorCopy(cause, 'Pairing failed'));
        }
      } finally {
        clearTimeout(feedback);
      }
    },
    [connectorId, helpers, startObserving, stopObserving, workspaceId],
  );

  useEffect(() => {
    // A pairing already under way is observed, never started again.
    if (offerCeremony || pairedConnectorId || autoPairRef.current || helpers === null || pairedHelperRef.current) return;
    const online = helpers.filter((helper) => helper.online);
    const requested = online.find((helper) => helper.id === requestedHelperId);
    if (requested) {
      autoPairRef.current = true;
      void pair(requested.id);
      return;
    }
    if (requestedHelperId || online.length !== 1) return;
    autoPairRef.current = true;
    void pair(online[0]!.id);
  }, [helpers, offerCeremony, pair, pairedConnectorId, requestedHelperId]);

  const retry = useCallback(() => {
    setError(null);
    if (observed.error && !observed.installMissing) {
      void observed.retry();
      return;
    }
    stopObserving();
    setInstall(null);
    if (offerId) {
      void monolithPhoneOperation('acceptConnectorOffer', { offerId })
        .then((accepted) => {
          if (accepted.status !== 'accepted') startObserving(accepted.connectorId);
        })
        .catch((cause) => {
          setError(appErrorCopy(cause, 'Pairing failed'));
        });
      return;
    }
    const helperId = pairedHelperRef.current;
    if (helperId) void pair(helperId);
  }, [observed.error, observed.installMissing, observed.retry, offerId, pair, startObserving, stopObserving]);

  const connectorName = connectorNameFor(connectorId);
  const machineName = install?.helperName ?? selectedHelperName;

  const requestedHelper = helpers?.find((helper) => helper.id === requestedHelperId);
  const requestedUnavailable = Boolean(requestedHelperId && helpers !== null && !requestedHelper?.online);
  const noHelpers = !requestedHelperId && helpers !== null && helpers.every((helper) => !helper.online);
  // Only online helpers are eligible. A sole eligible machine has no choice
  // to make; the helper row still stays visible above installation output.
  const onlineHelpers = helpers?.filter((helper) => helper.online &&
    (!requestedHelperId || helper.id === requestedHelperId)) ?? [];
  const someHelpers = onlineHelpers.length > 0;

  const stages: InstallStage[] = install === null ? []
    : connectorId === 'trusty-squire' && install.steps.some((step) => isSquireStageLabel(step.label))
      ? squirePairingStages(install.steps, machineName, Boolean(install.signIn))
      : genericInstallStages(install.steps);
  const failedStage = stages.find((stage) => stage.status === 'failed');
  const currentStage = failedStage ?? stages.find((stage) => stage.status === 'current');
  const stageNumber = currentStage ? stages.indexOf(currentStage) + 1 : stages.length;
  const openSignIn = () => {
    const signIn = install?.signIn;
    if (!install || !signIn) return;
    router.push({
      pathname: '/beeline/settings/workbench/connect-signin' as never,
      params: {
        workspaceId,
        viewerId,
        // The paired ROW id, so the overlay observes this
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
  };

  return (
    <View style={[styles.container, desktopPageLayout && { width: '100%', maxWidth: desktopColumnWidths.detail, alignSelf: 'center' }, { paddingTop: insets.top }]}>
      <PageHeader
        backAccessibilityLabel="Back to Connectors"
        eyebrow="Connectors"
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
        {requestedUnavailable && !offerCeremony ? (
          <SettingsRow
            title={requestedHelper?.name ?? 'Selected machine'}
            description="Unavailable — waiting for this machine to come online"
            testID="connect-requested-unavailable"
          />
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
            <RoomListSectionHeader title="Helpers" inset="content" />
            {onlineHelpers.length === 1 ? (
              <SettingsRow appBoard title={onlineHelpers[0]!.name}
                description={install ? 'paired' : 'pairing automatically'}
                testID={`connect-machine-${onlineHelpers[0]!.id}`} />
            ) : (
              onlineHelpers.map((helper) => (
              <SettingsRow
                appBoard
                key={helper.id}
                description={pairedHelperRef.current === helper.id ? 'paired' : 'online'}
                disabled={Boolean(pairedHelperRef.current)}
                onPress={() => void pair(helper.id)}
                testID={`connect-machine-${helper.id}`}
                title={helper.name}
                action={pairedHelperRef.current ? undefined : 'pair'}
              />
            ))
            )}
            {onlineHelpers.length > 1 && !pairedHelperRef.current ? (
              <Text style={styles.note}>Choose the machine that will hold your keys.</Text>
            ) : null}
          </View>
        ) : null}
        {install !== null ? (
          <View testID="connect-install-progress">
            <Text style={styles.progress} testID="connect-progress-count">
              {failedStage ? `Stopped at step ${stageNumber} of ${stages.length}`
                : currentStage ? `Step ${stageNumber} of ${stages.length} · ${machineName ?? 'your computer'}`
                  : `${stages.length} of ${stages.length} done`}
            </Text>
            <View style={styles.steps}>
              {stages.map((stage, index) => (
                <View key={`${stage.label}-${index}`} style={styles.step}
                  testID={`connect-step-${index}-${stage.status}`}>
                  <View style={styles.stepMark}>
                    {stage.status === 'current' && !(stage.key === 'sign-in' && install.signIn)
                      ? <ActivityIndicator size="small" color={theme.buzz.accent}
                        accessibilityLabel={`${stage.label}, in progress`} testID={`connect-step-${index}-spinner`} />
                      : <WorkflowStepCircle status={stage.status} />}
                  </View>
                  <View style={styles.stepBody}>
                    <Text style={[styles.stepText, stage.status === 'pending' && styles.stepPending,
                      stage.status === 'current' && styles.stepCurrent]}>
                      {stage.label}
                    </Text>
                    {stage.command ? (
                      <Text style={styles.stepCommand} testID={`connect-step-${index}-command`}>
                        $ {stage.command}
                      </Text>
                    ) : null}
                    {stage.output ? (
                      <Text style={styles.stepOutput} testID={`connect-step-${index}-output`}>
                        {stage.output}
                      </Text>
                    ) : null}
                    {stage.reason ? (
                      <Text style={styles.stepReason} testID={`connect-step-${index}-reason`}>
                        {stage.reason}
                      </Text>
                    ) : null}
                    {stage.key === 'sign-in' && stage.status === 'current' && install.signIn && !failedStage ? (
                      <View style={styles.signInBlock}>
                        <Text style={styles.note}>Waiting for you to sign in.</Text>
                        <Button
                          label="Sign in to Google"
                          onPress={openSignIn}
                          testID="connect-sign-in"
                          variant="primary"
                          destination="screen"
                        />
                        {connectorSignInLocationLine(install.signIn.browserLocation) ? (
                          <Text style={styles.note} testID="connect-sign-in-location">
                            {connectorSignInLocationLine(install.signIn.browserLocation)}
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
            {failedStage ? (
              <ErrorBanner inline title="Connection failed" onRetry={retry} retryTestID="connect-retry" />
            ) : install.signIn && !stages.some((stage) => stage.key === 'sign-in') ? (
              <View style={styles.signInBlock}>
                <Button
                  label={`Sign in to ${connectorName}`}
                  onPress={openSignIn}
                  testID="connect-sign-in"
                  variant="primary"
                  destination="screen"
                />
                {connectorSignInLocationLine(install.signIn.browserLocation) ? (
                  <Text style={styles.note} testID="connect-sign-in-location">
                    {connectorSignInLocationLine(install.signIn.browserLocation)}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
        {error || helperLoadError ? (
          <ErrorBanner inline title={error ?? 'Helpers are unavailable right now'} titleTestID="connect-error"
            onRetry={pairedHelperRef.current || observedId ? retry : undefined} retryTestID="connect-pair-retry" />
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
      paddingHorizontal: hull.space.lg,
      paddingTop: hull.layout.screenTop,
      gap: hull.layout.sectionGap,
      paddingBottom: hull.space.xxl,
    },
    loading: { alignItems: 'center', gap: hull.space.sm, paddingVertical: hull.space.xl },
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
    progress: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary, marginBottom: hull.space.sm },
    steps: { gap: hull.space.md },
    step: { flexDirection: 'row', gap: hull.space.sm, alignItems: 'flex-start' },
    // The circle and the spinner share one 20 pt column centred on the label's first line.
    stepMark: { width: 20, height: hull.type.body.lineHeight, alignItems: 'center', justifyContent: 'center' },
    stepBody: { flex: 1, minWidth: 0, gap: hull.space.xs },
    stepText: { ...Typography.default(), ...hull.type.body, color: hull.textSecondary },
    stepCurrent: { color: hull.textPrimary },
    stepPending: { color: hull.textMuted },
    stepCommand: {
      ...Typography.mono(),
      ...hull.type.meta,
      color: hull.textMuted,
      marginTop: hull.space.xs,
    },
    stepOutput: {
      ...Typography.mono(),
      ...hull.type.meta,
      color: hull.textSecondary,
      opacity: 0.85,
      marginTop: hull.space.xs,
    },
    stepReason: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger },
    signInBlock: { gap: hull.space.sm, marginTop: hull.space.xs },
    errorText: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger },
  };
});
