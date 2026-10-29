import { appErrorCopy } from '@/buzz/app-error-copy';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/buzz/Button';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { InlineRow } from '@/components/buzz/IndexRow';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { useInstallObserver } from '@/buzz/use-observed-resource';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { connectorOfferCompletionRoute } from '@/buzz/connector-offer-ceremony';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import {
  squirePairingStages,
  type ConnectorInstallState,
  type ConnectorInstallStep,
} from '@/buzz/workbench';
import {
  ConnectStepBar,
  ConnectStepDot,
  type ConnectBarPart,
  type ConnectStepState,
} from '@/components/buzz/ConnectProgress';

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

/**
 * Connect a machine tool — one page for pairing, installation and the sign-in
 * hand-off (Trusty Squire mock v3): four fixed steps, a step bar, a one-minute
 * limit on reaching the computer, and one primary action in the footer.
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

/** One row of the connect stepper, already in the words the person reads. */
type StepView = { key: string; title: string; state: ConnectStepState; detail?: string; error?: boolean };

/** Step 1 stops after this long without an answer from the computer. */
const REACH_TIMEOUT_MS = 60_000;

const SQUIRE_PHASE: Record<string, string> = {
  reach: 'Reaching', install: 'Installing', pair: 'Pairing', 'sign-in': 'Google sign-in',
};

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The helper's own wording for an ended sign-in page never reaches the person. */
function stepReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return /expired/i.test(reason) ? 'Sign-in closed before it finished. Try again.' : reason;
}

/** The four Trusty Squire stages in the mock's words (Trusty Squire mock v3). */
function squireSteps(install: ConnectorInstallState | null, machine: string, elapsedMs: number,
  timedOut: boolean): StepView[] {
  const steps = install?.steps ?? [];
  const version = steps.map((step) => /^trusty-squire (\S+) installed$/i.exec(step.label.trim())?.[1]).find(Boolean);
  const stages = squirePairingStages(steps, machine, Boolean(install?.signIn));
  return stages.filter((stage) => stage.key !== 'other').map((stage) => {
    const failed = stage.status === 'failed' || (stage.key === 'reach' && stage.status === 'current' && timedOut);
    const reason = stepReason(stage.reason);
    if (stage.key === 'reach') {
      return { key: 'reach', title: `Reach ${machine}`,
        state: stage.status === 'done' ? 'done' : failed ? 'failed' : 'current',
        detail: stage.status === 'done' ? 'Helper online'
          : timedOut || stage.status === 'failed'
            ? reason ?? `${machine} didn’t answer for 1 minute. Check it is on and online.`
            : `Reconnecting · ${clock(elapsedMs)} · stops at ${clock(REACH_TIMEOUT_MS)}` };
    }
    const state: ConnectStepState = stage.status === 'done' ? 'done' : stage.status === 'failed' ? 'failed'
      : stage.status === 'pending' ? 'todo'
        : stage.key === 'sign-in' ? (install?.signIn ? 'waiting' : 'current') : 'current';
    if (stage.key === 'install') {
      return { key: 'install', title: 'Install Trusty Squire', state,
        detail: state === 'failed' ? reason : version ? `Version ${version}` : 'Latest version' };
    }
    if (stage.key === 'pair') {
      return { key: 'pair', title: 'Pair to this workspace', state,
        detail: state === 'failed' ? reason : state === 'done' ? 'Paired'
          : state === 'current' ? 'Pairing… usually under 10 seconds' : `Links ${machine} to this workspace` };
    }
    return { key: 'sign-in', title: 'Sign in to Google', state,
      detail: state === 'failed' ? reason : `Opens a secure browser on ${machine}` };
  });
}

/** Any other connector's own steps: the running (or first unfinished) one is current. */
function genericSteps(steps: readonly ConnectorInstallStep[], signInOpen: boolean): StepView[] {
  const failed = steps.some((step) => step.status === 'failed');
  let current = failed || steps.some((step) => step.status === 'active');
  return steps.map((step, index) => {
    const pendingCurrent = step.status === 'pending' && !current ? (current = true) : false;
    const state: ConnectStepState = step.status === 'done' ? 'done' : step.status === 'failed' ? 'failed'
      : step.status === 'active' || pendingCurrent ? (signInOpen && index === steps.length - 1 ? 'waiting' : 'current') : 'todo';
    return { key: `${index}`, title: step.label, state,
      ...(step.reason ? { detail: step.reason } : {}) };
  });
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
  const requestedHelperId = firstParam(params.helperId)
    ?? (pairedConnectorId?.startsWith('squire:') ? pairedConnectorId.slice(7) : undefined);
  const offerCeremony = Boolean(offerId && pairedConnectorId && roomId);
  const squire = connectorId === 'trusty-squire';
  const { value: workbench, error: helperLoadError } = useSharedWorkbench(
    offerCeremony ? null : { workspaceId, viewerId });
  const helpers = workbench?.helpers ?? null;
  const [install, setInstall] = useState<ConnectorInstallState | null>(null);
  const [selectedHelperName, setSelectedHelperName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
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
    if (!observed.data) return;
    setInstall(observed.data);
    if (!observed.data.connected) return;
    router.replace((roomId || !squire ? connectorOfferCompletionRoute(roomId)
      : { pathname: '/beeline/settings/workbench/service', params: { workspaceId, viewerId, service: 'trusty-squire' } }) as Href);
  }, [observed.data, roomId, squire, viewerId, workspaceId]);
  useEffect(() => { if (observed.error) setError(observed.error); }, [observed.error]);

  const pair = useCallback(
    async (helperId: string) => {
      stopObserving();
      setError(null);
      setInstall(null);
      setStartedAt(Date.now());
      setNow(Date.now());
      pairedHelperRef.current = helperId;
      setSelectedHelperName(helpers?.find((helper) => helper.id === helperId)?.name ?? null);
      try {
        const { connectorId: pairedConnectorId } = await getWorkbenchSource().pairConnector({
          workspaceId,
          connectorId,
          helperId,
        });
        startObserving(pairedConnectorId);
      } catch (cause) {
        setError(appErrorCopy(cause, 'Pairing failed'));
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
    setStartedAt(Date.now());
    setNow(Date.now());
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
    const helperId = pairedHelperRef.current ?? requestedHelperId;
    if (helperId) {
      autoPairRef.current = true;
      void pair(helperId);
    }
  }, [observed.error, observed.installMissing, observed.retry, offerId, pair, requestedHelperId, startObserving, stopObserving]);

  const connectorName = connectorNameFor(connectorId);
  const requestedHelper = helpers?.find((helper) => helper.id === requestedHelperId);
  const machineName = install?.helperName ?? selectedHelperName ?? requestedHelper?.name ?? 'your computer';
  const noHelpers = !requestedHelperId && !pairedHelperRef.current && helpers !== null && helpers.every((helper) => !helper.online);
  const onlineHelpers = helpers?.filter((helper) => helper.online) ?? [];
  // A choice exists only while nothing was named or paired yet.
  const choosing = !offerCeremony && !requestedHelperId && !pairedHelperRef.current && onlineHelpers.length > 1;
  const showSteps = offerCeremony || Boolean(requestedHelperId || pairedHelperRef.current || install);

  const steps = squire ? squireSteps(install, machineName, now - startedAt, false)
    : genericSteps(install?.steps ?? [], Boolean(install?.signIn));
  const reachPending = squire && steps[0]?.key === 'reach' && steps[0].state === 'current';
  const timedOut = reachPending && now - startedAt >= REACH_TIMEOUT_MS;
  const counted = squire ? squireSteps(install, machineName, now - startedAt, timedOut) : steps;
  // A failed request or read stops the step it was on and says why there.
  const stoppedAt = counted.findIndex((step) => step.state !== 'done');
  const shown = error && !counted.some((step) => step.state === 'failed') && stoppedAt >= 0
    ? counted.map((step, index) => index === stoppedAt ? { ...step, state: 'failed' as const, detail: error, error: true } : step)
    : counted;
  // Step 1 counts its own minute, then stops; nothing on this page spins forever.
  useEffect(() => {
    if (!reachPending || timedOut || error) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [reachPending, timedOut, error]);

  const failedIndex = shown.findIndex((step) => step.state === 'failed');
  const activeIndex = failedIndex >= 0 ? failedIndex
    : shown.findIndex((step) => step.state === 'current' || step.state === 'waiting');
  const stepNumber = activeIndex >= 0 ? activeIndex + 1 : shown.length;
  const parts: ConnectBarPart[] = shown.map((_, index) => index < stepNumber - 1 ? 'filled'
    : index === stepNumber - 1 ? (failedIndex >= 0 ? 'failed' : activeIndex >= 0 ? 'active' : 'filled') : 'empty');
  useEffect(() => {
    if (!squire || activeIndex < 0 || shown[activeIndex]?.state !== 'current' || shown[activeIndex]?.key === 'reach') return;
    const timer = setTimeout(() => setError('This step has not finished. Try again.'), 120_000);
    return () => clearTimeout(timer);
  }, [squire, activeIndex, shown[activeIndex]?.state, shown[activeIndex]?.key]);
  // An error with no step to stop (no steps reported yet) still ends the run visibly.
  const errorUnplaced = Boolean(error) && !shown.some((step) => step.error);
  const failed = failedIndex >= 0 || errorUnplaced;
  const signInReady = !failed && Boolean(install?.signIn);
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
        machineName,
        url: signIn.url,
        method: signIn.method,
        ...(offerId ? { offerId } : {}),
        ...(roomId ? { roomId } : {}),
      },
    });
  };
  const signInLabel = squire ? 'Sign in to Google' : `Sign in to ${connectorName}`;

  return (
    <View style={[styles.container, desktopPageLayout && { width: '100%', maxWidth: desktopColumnWidths.detail, alignSelf: 'center' }, { paddingTop: insets.top }]}>
      <PageHeader
        backAccessibilityLabel={`Back to ${connectorName}`}
        eyebrow={connectorName}
        prominent
        onBack={() => router.back()}
        testID="connect-header"
        title={showSteps && squire ? `Connect ${machineName}` : connectorName}
      />
      <ScrollView style={styles.content} testID="connect-scroll"
        contentContainerStyle={[styles.contentInner, !showSteps && { paddingBottom: theme.buzz.space.lg + insets.bottom }]}>
        {helpers === null && !helperLoadError && !offerCeremony && !showSteps ? (
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
            <Text style={styles.empty} testID="connect-no-helper-empty">No online helpers found</Text>
            <View style={styles.commandBlock} testID="connect-no-helper-command">
              <Text style={styles.command}>npx usebeeline connect</Text>
              <Text style={styles.note}>
                Run this on the machine you want to hold your keys. When it appears here, come back
                and pair it.
              </Text>
            </View>
          </View>
        ) : null}
        {choosing ? (
          <View testID="connect-machine-picker">
            <RoomListSectionHeader title="Helpers" inset="content" />
            {onlineHelpers.map((helper) => (
              <SettingsRow appBoard key={helper.id} description="online" onPress={() => void pair(helper.id)}
                testID={`connect-machine-${helper.id}`} title={helper.name} action="pair" />
            ))}
            <Text style={styles.note}>Choose the machine that will hold your keys.</Text>
          </View>
        ) : null}
        {showSteps ? (
          <View testID="connect-install-progress">
            <View style={styles.progress}>
              <InlineRow style={styles.progressLine}>
                <Text style={styles.progressCount} testID="connect-progress-count">Step {stepNumber} of {shown.length}</Text>
                {squire && activeIndex >= 0 ? (
                  <Text style={styles.progressPhase}>
                    {shown[activeIndex]!.key === 'reach' ? `Reaching ${machineName}` : SQUIRE_PHASE[shown[activeIndex]!.key]}
                  </Text>
                ) : null}
              </InlineRow>
              <ConnectStepBar parts={parts} testID="connect-step-bar" />
            </View>
            {shown.map((step, index) => (
              <InlineRow key={step.key} style={styles.step} testID={`connect-step-${index}-${step.state}`}>
                {index < shown.length - 1 ? <View style={[styles.rail, step.state === 'done' && styles.railDone]} /> : null}
                <ConnectStepDot number={index + 1} state={step.state} testID={`connect-step-${index}-dot`} />
                <View style={styles.stepCopy}>
                  <Text style={[styles.stepTitle, step.state === 'todo' && styles.stepTitleTodo]}>{step.title}</Text>
                  {step.detail ? (
                    <Text style={[styles.stepDetail, step.state === 'current' && styles.stepDetailCurrent,
                      step.state === 'failed' && styles.stepDetailFailed]} testID={step.error ? 'connect-error' : `connect-step-${index}-detail`}>
                      {step.detail}
                    </Text>
                  ) : null}
                </View>
              </InlineRow>
            ))}
          </View>
        ) : null}
        {errorUnplaced ? <Text style={styles.failure} testID="connect-error">{error}</Text> : null}
        {helperLoadError && !helpers ? <Text style={styles.failure} testID="connect-error">Helpers are unavailable right now</Text> : null}
      </ScrollView>
      {showSteps ? (
        <View style={[styles.foot, { paddingBottom: theme.buzz.space.lg + insets.bottom }]}>
          {failed ? (
            <>
              <Button appearance={{ control: styles.primaryButton, label: styles.primaryLabel }} label="Try again" fullWidth onPress={retry} testID="connect-retry" />
              <Text style={styles.footNote}>
                {failedIndex <= 0 ? `Sign in unlocks once ${machineName} answers.` : 'Sign in unlocks when pairing finishes.'}
              </Text>
            </>
          ) : (
            <>
              {/* Locked, the primary keeps its fill at a third of its strength (mock v3). */}
              <View pointerEvents={signInReady ? 'auto' : 'none'} style={!signInReady && styles.locked}>
                <Button appearance={{ control: styles.primaryButton, label: styles.primaryLabel }} label={signInLabel} fullWidth disabled={!signInReady} accessibilityState={{ disabled: !signInReady }}
                  onPress={signInReady ? openSignIn : () => undefined} testID="connect-sign-in" />
              </View>
              <Text style={styles.footNote}>
                {signInReady ? `Opens ${machineName}’s secure browser. About a minute.` : 'Unlocks when pairing finishes.'}
              </Text>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

const DOT = 28;

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.appCanvas },
    content: { flex: 1 },
    contentInner: { paddingHorizontal: hull.space.lg, paddingTop: hull.layout.screenTop, paddingBottom: hull.space.lg },
    loading: { alignItems: 'center', gap: hull.space.sm, paddingVertical: hull.space.xl },
    note: { ...Typography.default(), ...hull.type.meta, color: hull.appQuiet },
    failure: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger, marginTop: hull.space.md },
    // The empty state's one centered fact (board: `emp`).
    empty: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary, textAlign: 'center', paddingVertical: hull.space.md },
    // The one raised block: the CLI command the user must run, boxed because
    // it is the one thing the page asks them to act on.
    commandBlock: {
      borderWidth: StyleSheet.hairlineWidth, borderColor: hull.border, borderRadius: hull.radius,
      padding: hull.space.md, gap: hull.space.sm,
    },
    command: { ...Typography.mono(), ...hull.type.body, color: hull.textPrimary },
    progress: { marginBottom: hull.squireConnect.progressBottom },
    progressLine: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: hull.squireConnect.contentGap },
    progressCount: { ...hull.type.meta, fontFamily: 'SpaceGrotesk-Medium', color: hull.appInk },
    progressPhase: { ...hull.type.meta, color: hull.textMuted },
    step: { flexDirection: 'row', gap: hull.space.md, paddingBottom: hull.squireConnect.stepBottom },
    // The 2 pt line from one step mark down to the next.
    rail: { position: 'absolute', left: DOT / 2 - 1, top: 30, bottom: 2, width: 2, borderRadius: hull.squireConnect.railRadius, backgroundColor: hull.appBorder },
    railDone: { backgroundColor: hull.accent },
    stepCopy: { flex: 1, minWidth: 0, paddingTop: hull.squireConnect.copyTop },
    stepTitle: { ...hull.type.body, color: hull.appInk },
    stepTitleTodo: { color: hull.textMuted },
    stepDetail: { ...hull.type.meta, color: hull.appQuiet },
    stepDetailCurrent: { color: hull.accent },
    stepDetailFailed: { color: hull.dialogDanger },
    foot: {
      paddingHorizontal: hull.space.lg, paddingTop: hull.space.md, gap: hull.squireConnect.contentGap,
      borderTopWidth: 1, borderTopColor: hull.appBorder, backgroundColor: hull.appCanvas,
    },
    primaryButton: { minHeight: 48, borderRadius: hull.radius, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', backgroundColor: hull.appInk, borderWidth: 1, borderColor: hull.appInk },
    primaryLabel: { ...hull.type.body, fontFamily: 'SpaceGrotesk-Medium', color: hull.appCanvas },
    locked: { opacity: 0.32 },
    footNote: { ...hull.type.meta, color: hull.textMuted, textAlign: 'center' },
  };
});
