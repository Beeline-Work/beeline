import { appErrorCopy } from '@/buzz/app-error-copy';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as WebBrowser from 'expo-web-browser';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/buzz/Button';
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
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
  }>();
  const workspaceId = first(params.workspaceId) ?? '';
  const viewerId = first(params.viewerId) ?? '';
  const connectorId = first(params.connectorId) ?? '';
  const connectorName = first(params.connectorName) ?? 'App';
  const roomId = first(params.roomId);
  const [signIn, setSignIn] = useState({ url: first(params.url) ?? '', method: first(params.method) ?? 'streamed' });
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageLoaded, setPageLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [fallback, setFallback] = useState(false);
  // Quick-tunnel names can lag DNS: a load that fails at once usually works a
  // few seconds later, so the page reloads itself before saying it failed.
  const [autoReloads, setAutoReloads] = useState(0);
  const insets = useSafeAreaInsets();
  const desktopPageLayout = useDesktopPageLayout();
  const WebView = useSandboxWebView();

  const finish = useCallback(() => router.replace(roomId ? (connectorOfferCompletionRoute(roomId) as Href )
          : ({ pathname: '/beeline/settings/workbench', params: { workspaceId, viewerId } } as Href),
      ), [roomId, viewerId, workspaceId],
  );
  const observed = useInstallObserver(workspaceId, connectorId);
  const squire = connectorId.startsWith('squire:') || connectorName === 'Trusty Squire';
  useEffect(() => {
    const timer = setTimeout(() => setPageError(pageLoaded
      ? 'Sign-in is still waiting.'
      : PAGE_LOAD_ERROR), pageLoaded ? 120_000 : 15_000 + PAGE_AUTO_RELOADS * PAGE_RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [signIn.url, pageLoaded]);
  // Android reports a failed load as finished too; only a clean finish counts.
  const loadFailed = useRef(false);
  const pageFailed = useCallback(() => {
    // The finish event can arrive before the error that caused it.
    loadFailed.current = true;
    setPageLoaded(false);
    if (autoReloads >= PAGE_AUTO_RELOADS) { setPageError(PAGE_LOAD_ERROR); return; }
    setTimeout(() => {
      loadFailed.current = false;
      setAutoReloads(value => value + 1); setAttempt(value => value + 1);
    }, PAGE_RELOAD_DELAY_MS);
  }, [autoReloads]);
  const retry = useCallback(async () => {
    setAutoReloads(0);
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
    else if (state.steps?.some(step => step.status === 'failed')) setPageError('Google sign-in could not start. Go back and reconnect this computer.');
  }, [observed.data, finish]);

  const openBrowser = useCallback(async () => {
    if (!signIn.url) return;
    await WebBrowser.openBrowserAsync(signIn.url);
    setFallback(true);
  }, [signIn.url]);

  const errorTitle = observed.error ?? pageError;
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]} testID="signin-overlay">
      <View style={[styles.column, desktopPageLayout && { width: '100%', maxWidth: desktopColumnWidths.detail, alignSelf: 'center' }]} testID="signin-card">
        <PageHeader backAccessibilityLabel="Close sign-in" eyebrow="Connectors" prominent onBack={() => router.back()} testID="signin-header" title={squire ? 'Sign in to Google' : `Sign in to ${connectorName}`} />
        {squire ? <Text style={styles.lede}>Sign in to Google once. Trusty Squire then signs in to websites and APIs for you.</Text> : null}
        {errorTitle ? (
          <View style={styles.errorBlock}>
            <ErrorBanner
              title={errorTitle}
              description={!observed.error && signIn.url ? 'Retry, or open it in your browser.' : undefined}
              onRetry={observed.installMissing ? () => router.back() : () => void retry()}
              retryLabel={observed.installMissing ? 'Go back' : 'Retry'}
              retryTestID="signin-retry"
              secondaryAction={!observed.installMissing && signIn.url
                ? { label: 'Open in browser', onPress: () => void openBrowser(), testID: 'signin-open-external' } : undefined}
              testID="signin-error"
            />
          </View>
        ) : null}
        {!pageError && signIn.method === 'oauth' ? (
          <View style={styles.centered} testID="signin-oauth-browser">
            <Text style={styles.note}>{connectorName} sign-in opens in your browser. Return here after granting access.</Text>
            <Button label={`Continue with ${connectorName}`} destination="external" onPress={() => void openBrowser()} testID="signin-open-external" />
          </View>
        ) : !pageError && WebView && signIn.url ? (
          <View style={styles.webFrame}>
            {React.createElement(WebView, { key: `${signIn.url}:${attempt}`, onLoad: () => { if (!loadFailed.current) setPageLoaded(true); }, onError: pageFailed, onHttpError: pageFailed, renderError: () => null, source: { uri: signIn.url }, style: styles.webView, javaScriptEnabled: true, domStorageEnabled: true, testID: 'signin-webview' })}
            {!pageLoaded ? (
              <View style={styles.webLoading} testID="signin-webview-loading">
                <ActivityIndicator accessibilityLabel="Opening the sign-in page" />
                <Text style={styles.note}>{autoReloads ? 'Still opening the sign-in page…' : 'Opening the sign-in page…'}</Text>
                {autoReloads ? <Button label="Open in browser" variant="secondary" destination="external"
                  onPress={() => void openBrowser()} testID="signin-open-external" /> : null}
              </View>
            ) : null}
          </View>
        ) : fallback ? (
          <View style={styles.centered}><Text style={styles.note}>Finish sign-in in the browser. This page moves on by itself when you are done.</Text></View>
        ) : !errorTitle ? (
          <View style={styles.centered}>
            <ActivityIndicator accessibilityLabel="Opening the sign-in page" testID="signin-webview-loading" />
            <Text style={styles.note}>Opening the sign-in page…</Text>
            {signIn.url ? <Button label="Open in browser" variant="secondary" destination="external" onPress={() => void openBrowser()} testID="signin-open-external" /> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Reloads before a failed page load is shown, and the pause between them. */
const PAGE_AUTO_RELOADS = 12;
const PAGE_RELOAD_DELAY_MS = 8_000;
const PAGE_LOAD_ERROR = 'The sign-in page did not load.';

const styles = StyleSheet.create(theme => ({
  returnScreen: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.buzz.bgTerminal },
  screen: { flex: 1, backgroundColor: theme.buzz.appCanvas },
  column: { flex: 1 },
  lede: { ...theme.buzz.type.body, color: theme.buzz.textSecondary, paddingHorizontal: theme.buzz.space.lg, paddingTop: theme.buzz.space.md, paddingBottom: theme.buzz.space.md },
  errorBlock: { paddingHorizontal: theme.buzz.space.sm, paddingBottom: theme.buzz.space.md },
  centered: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: theme.buzz.space.md, padding: theme.buzz.space.lg },
  note: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary, textAlign: 'center' },
  webFrame: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.buzz.border },
  webView: { flex: 1 },
  webLoading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: theme.buzz.space.sm, backgroundColor: theme.buzz.appCanvas },
}));
