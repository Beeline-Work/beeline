import { appErrorCopy } from '@/buzz/app-error-copy';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as WebBrowser from 'expo-web-browser';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/buzz/Button';
import { LoadingBar, RingSpinner } from '@/components/buzz/ConnectProgress';
import { PageHeader } from '@/components/buzz/PageHeader';
import { useSandboxWebView } from '@/components/buzz/sandbox-webview';
import { useInstallObserver } from '@/buzz/use-observed-resource';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { connectorOfferCompletionRoute } from '@/buzz/connector-offer-ceremony';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { takeAppSignInReturn } from '@/buzz/app-sign-in';

function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }

/** The provider returns a one-use verifier session; only the server can settle it. */
export default function ConnectorSignInScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench/connect-signin');
  const params = useLocalSearchParams<{ appSignInSession?: string | string[] }>();
  const sessionUri = first(params.appSignInSession);
  return sessionUri ? (
    <AppSignInReturnScreen sessionUri={sessionUri} /> ) : (
    <ConnectorSignInOverlay />);
}

function AppSignInReturnScreen({ sessionUri }: { sessionUri: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void takeAppSignInReturn().then(async (destination ) => {
      if (!destination?.appId) throw new Error('App sign-in could not be matched to a connection');
      await getWorkbenchSource().completeAppSignIn({ sessionUri, appId: destination.appId });
      if (!live) return;
      router.replace(destination?.roomId ? (connectorOfferCompletionRoute(destination.roomId) as Href )
            : ({ pathname: '/beeline/settings/workbench', params: { workspaceId: destination?.workspaceId ?? '', viewerId: destination?.viewerId ?? '' } } as Href),
        );
    }).catch(cause => { if (live) setError(appErrorCopy(cause, 'Sign-in could not be verified')); });
    return () => { live = false; };
  }, [sessionUri]);
  return (
    <View style={styles.returnScreen} testID="app-sign-in-return">
    {error ? (
        <SettingsRow title={error} /> ) : (
        <ActivityIndicator accessibilityLabel="Completing app sign-in" />)}
  </View>);
}

/** Existing Trusty Squire helper sign-in retains its streamed browser overlay. */
function ConnectorSignInOverlay() {
  const params = useLocalSearchParams<{
    workspaceId?: string | string[]; viewerId?: string | string[];
    connectorId?: string | string[]; connectorName?: string | string[];
    roomId?: string | string[]; offerId?: string | string[]; url?: string | string[]; method?: string | string[];
    machineName?: string | string[];
  }>();
  const workspaceId = first(params.workspaceId) ?? '';
  const viewerId = first(params.viewerId) ?? '';
  const connectorId = first(params.connectorId) ?? '';
  const connectorName = first(params.connectorName) ?? 'App';
  const roomId = first(params.roomId);
  const machineName = first(params.machineName) ?? 'your computer';
  const [signIn, setSignIn] = useState({ url: first(params.url) ?? '', method: first(params.method) ?? 'streamed' });
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageLoaded, setPageLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [fallback, setFallback] = useState(false);
  // Quick-tunnel names can lag DNS: a load that fails at once usually works a
  // few seconds later, so the page reloads itself before saying it failed.
  const [autoReloads, setAutoReloads] = useState(0);
  const [loadRound, setLoadRound] = useState(0);
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const desktopPageLayout = useDesktopPageLayout();
  const WebView = useSandboxWebView();

  const observed = useInstallObserver(workspaceId, connectorId);
  const squire = connectorId.startsWith('squire:') || connectorName === 'Trusty Squire';
  // A finished Squire sign-in lands on the Trusty Squire page, where the row now reads signed in.
  const finish = useCallback(() => router.replace(roomId ? (connectorOfferCompletionRoute(roomId) as Href )
          : squire ? ({ pathname: '/beeline/settings/workbench/service', params: { workspaceId, viewerId, service: 'trusty-squire' } } as Href)
            : ({ pathname: '/beeline/settings/workbench', params: { workspaceId, viewerId } } as Href),
      ), [roomId, squire, viewerId, workspaceId],
  );
  // The page has 15 seconds to load, reloads included, then says so in full.
  useEffect(() => {
    if (pageLoaded || fallback || signIn.method === 'oauth') return;
    const timer = setTimeout(() => setPageError(PAGE_LOAD_ERROR), PAGE_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [signIn.url, signIn.method, pageLoaded, fallback, loadRound]);
  // A stalled helper completion also ends visibly after the browser loads.
  useEffect(() => {
    const timer = setTimeout(() => setPageError('Sign-in has not finished. Try again.'), 120_000);
    return () => clearTimeout(timer);
  }, [signIn.url, loadRound]);
  // Android reports a failed load as finished too; only a clean finish counts.
  const loadFailed = useRef(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reloadTimer.current), []);
  const pageFailed = useCallback(() => {
    if (loadFailed.current) return;
    // The finish event can arrive before the error that caused it.
    loadFailed.current = true;
    setPageLoaded(false);
    if (autoReloads >= PAGE_AUTO_RELOADS) return;
    reloadTimer.current = setTimeout(() => {
      loadFailed.current = false;
      setAutoReloads(value => value + 1); setAttempt(value => value + 1);
    }, PAGE_RELOAD_DELAY_MS);
  }, [autoReloads]);
  const retry = useCallback(async () => {
    clearTimeout(reloadTimer.current);
    loadFailed.current = false;
    setFallback(false);
    setAutoReloads(0);
    setLoadRound(value => value + 1);
    setPageLoaded(false);
    setAttempt(value => value + 1);
    setPageError(null);
    try {
      if (observed.data?.steps.some(step => step.status === 'failed')) {
        const offerId = first(params.offerId);
        if (offerId) await monolithPhoneOperation('acceptConnectorOffer', { offerId });
        else if (connectorId.startsWith('squire:')) await getWorkbenchSource().pairConnector({
          workspaceId, connectorId: 'trusty-squire', helperId: connectorId.slice(7) });
      }
      await observed.retry();
    } catch { setPageError('Google sign-in could not restart. Try again.'); }
  }, [observed.retry, observed.data, params.offerId, connectorId, workspaceId]);
  useEffect(() => {
    const state = observed.data;
    if (!state) return;
    if (state.connected) { finish(); return; }
    if (state.signIn) setSignIn(current => current.url === state.signIn!.url ? current : { url: state.signIn!.url, method: state.signIn!.method });
    else if (state.steps?.some(step => step.status === 'failed')) setPageError(`Google sign-in could not start on ${machineName}. Go back and connect it again.`);
  }, [observed.data, finish, machineName]);

  const openBrowser = useCallback(async () => {
    if (!signIn.url) return;
    await WebBrowser.openBrowserAsync(signIn.url);
    setPageError(null);
    setFallback(true);
    void observed.retry();
  }, [signIn.url, observed.retry]);
  useEffect(() => {
    if (!fallback) return;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void observed.retry();
    });
    return () => subscription.remove();
  }, [fallback, observed.retry]);

  const failure = observed.error ?? pageError;
  const failureLine = failure === PAGE_LOAD_ERROR
    ? `${machineName}’s browser didn’t answer within 15 seconds. Try again, or finish sign-in in your phone’s browser.`
    : failure;
  const streamed = signIn.method !== 'oauth';
  const loading = streamed && !failure && !fallback && !pageLoaded;
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]} testID="signin-overlay">
      <View style={[styles.column, desktopPageLayout && { width: '100%', maxWidth: desktopColumnWidths.detail, alignSelf: 'center' }]} testID="signin-card">
        <PageHeader backAccessibilityLabel="Close sign-in" eyebrow={squire ? 'Step 4 of 4' : 'Connectors'} prominent onBack={() => router.back()} testID="signin-header" title={squire ? 'Sign in to Google' : `Sign in to ${connectorName}`} />
        {loading ? <LoadingBar testID="signin-loading-bar" /> : null}
        <View style={styles.body}>
          {streamed && !failure && !fallback && WebView && signIn.url ? (
            <View style={[styles.webFrame, !pageLoaded && styles.webHidden]}>
              {React.createElement(WebView, { key: `${signIn.url}:${attempt}`, onLoad: () => { if (!loadFailed.current) setPageLoaded(true); }, onError: pageFailed, onHttpError: pageFailed, renderError: () => null, source: { uri: signIn.url }, style: styles.webView, javaScriptEnabled: true, domStorageEnabled: true, testID: 'signin-webview' })}
            </View>
          ) : null}
          {!streamed && !failure ? (
            <View style={styles.center} testID="signin-oauth-browser">
              <Text style={styles.centerLine}>{connectorName} sign-in opens in your browser. Return here after granting access.</Text>
              <Button label={`Continue with ${connectorName}`} destination="external" onPress={() => void openBrowser()} testID="signin-open-external" />
            </View>
          ) : failure ? (
            <View style={styles.center} accessibilityLiveRegion="polite" testID="signin-error">
              <Text style={styles.centerTitle}>{squire ? 'Google sign-in didn’t load' : `${connectorName} sign-in didn’t load`}</Text>
              <Text style={styles.centerLine}>{failureLine}</Text>
            </View>
          ) : fallback ? (
            <View style={[styles.center, styles.centerBare]} testID="signin-finishing">
              <RingSpinner size={32} accessibilityLabel="Finishing sign-in" />
              <Text style={styles.centerTitle}>Finishing sign-in…</Text>
              <Text style={styles.centerLine}>You signed in on Chrome. {machineName} is saving the session. This page switches to connected by itself.</Text>
            </View>
          ) : loading ? (
            <View style={[styles.center, styles.cover]} testID="signin-webview-loading">
              <RingSpinner size={32} accessibilityLabel="Loading Google sign-in" />
              <Text style={styles.centerTitle}>{squire ? 'Loading Google sign-in…' : `Loading ${connectorName} sign-in…`}</Text>
              <Text style={styles.centerLine}>From {machineName}’s secure browser</Text>
            </View>
          ) : null}
        </View>
        {failure ? (
          <View style={[styles.foot, { paddingBottom: theme.buzz.space.lg + insets.bottom }]}>
            <Button appearance={{ control: styles.primaryButton, label: styles.primaryLabel }} label={observed.installMissing ? 'Go back' : 'Try again'} fullWidth
              onPress={observed.installMissing ? () => router.back() : () => void retry()} testID="signin-retry" />
            {!observed.installMissing && signIn.url
              ? <Button appearance={{ control: styles.secondaryButton, label: styles.secondaryLabel }} label="Open in browser" variant="secondary" fullWidth onPress={() => void openBrowser()} testID="signin-open-external" /> : null}
          </View>
        ) : loading && signIn.url ? (
          <View style={[styles.foot, { paddingBottom: theme.buzz.space.lg + insets.bottom }]}>
            <Button appearance={{ control: styles.secondaryButton, label: styles.secondaryLabel }} label="Open in browser instead" variant="secondary" fullWidth onPress={() => void openBrowser()} testID="signin-open-external" />
          </View>
        ) : <View style={{ height: insets.bottom }} />}
      </View>
    </View>
  );
}

/** A page that fails while its name is new reloads itself inside the 15 seconds. */
const PAGE_AUTO_RELOADS = 2;
const PAGE_RELOAD_DELAY_MS = 5_000;
const PAGE_LOAD_TIMEOUT_MS = 15_000;
const PAGE_LOAD_ERROR = 'The sign-in page did not load.';

const styles = StyleSheet.create(theme => ({
  primaryButton: { minHeight: 48, borderRadius: theme.buzz.radius, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.buzz.appInk, borderWidth: 1, borderColor: theme.buzz.appInk },
  primaryLabel: { ...theme.buzz.type.body, fontFamily: 'SpaceGrotesk-Medium', color: theme.buzz.appCanvas },
  secondaryButton: { minHeight: 48, borderRadius: theme.buzz.radius, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.buzz.borderStrong },
  secondaryLabel: { ...theme.buzz.type.body, fontFamily: 'SpaceGrotesk-Medium', color: theme.buzz.appInk },
  returnScreen: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.buzz.bgTerminal },
  screen: { flex: 1, backgroundColor: theme.buzz.appCanvas },
  column: { flex: 1 },
  body: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.buzz.squireConnect.contentGap, paddingHorizontal: theme.buzz.squireConnect.centerSide, paddingBottom: theme.buzz.squireConnect.centerBottom },
  // With no footer below, the same optical centre sits higher in a taller body.
  centerBare: { paddingBottom: theme.buzz.squireConnect.bareBottom },
  cover: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.buzz.appCanvas },
  centerTitle: { ...theme.buzz.squireConnect.titleType, marginTop: theme.buzz.space.sm, color: theme.buzz.appInk, textAlign: 'center' },
  centerLine: { ...theme.buzz.squireConnect.detailType, color: theme.buzz.appQuiet, maxWidth: 300, textAlign: 'center' },
  webFrame: { flex: 1 },
  webHidden: { opacity: 0 },
  webView: { flex: 1 },
  foot: { paddingHorizontal: theme.buzz.space.lg, paddingTop: theme.buzz.space.md, gap: theme.buzz.squireConnect.contentGap, borderTopWidth: 1, borderTopColor: theme.buzz.appBorder, backgroundColor: theme.buzz.appCanvas },
}));
