import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as WebBrowser from 'expo-web-browser';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { AnimatedBlurBackdrop } from '@/components/AnimatedOverlay';
import { Button } from '@/components/buzz/Button';
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
    }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : 'Sign-in could not be verified'); });
    return () => { live = false; };
  }, [sessionUri]);
  return (
    <View style={styles.returnScreen} testID="app-sign-in-return">
    {error ? (
        <Text accessibilityRole="alert" style={styles.error}>{error}</Text> ) : (
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
  const insets = useSafeAreaInsets();
  const WebView = useSandboxWebView();

  const finish = useCallback(() => router.replace(roomId ? (connectorOfferCompletionRoute(roomId) as Href )
          : ({ pathname: '/beeline/settings/workbench', params: { workspaceId, viewerId } } as Href),
      ), [roomId, viewerId, workspaceId],
  );
  const observed = useInstallObserver(workspaceId, connectorId);
  const squire = connectorId.startsWith('squire:') || connectorName === 'Trusty Squire';
  useEffect(() => {
    const timer = setTimeout(() => setPageError(pageLoaded
      ? 'Sign-in is still waiting. Retry or open it in your browser.'
      : 'The sign-in page did not load. Retry or open it in your browser.'), pageLoaded ? 120_000 : 15_000);
    return () => clearTimeout(timer);
  }, [signIn.url, attempt, pageLoaded]);
  const retry = useCallback(async () => {
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

  return (
    <View style={styles.scrim} testID="signin-overlay">
    <AnimatedBlurBackdrop interactive={false} blurIntensity={48} />
    <View style={[styles.card, { marginTop: insets.top + 24, marginBottom: insets.bottom + 24 }]} testID="signin-card">
      <PageHeader backAccessibilityLabel="Close sign-in" eyebrow="Connectors" prominent onBack={() => router.back()} testID="signin-header" title={squire ? 'Sign in to Google' : `Sign in to ${connectorName}`} />
        {squire ? <Text style={styles.note}>Sign in to Google once, so Trusty Squire can sign in to websites and APIs for you hands-free.</Text> : null}
        {observed.error || pageError ? (
          <View>
            <Text accessibilityRole="alert" style={styles.error}>
              {observed.error ?? pageError}
            </Text>
            <Button
              label="Retry"
              variant="secondary"
              style={{ alignSelf: 'flex-end' }}
              onPress={observed.installMissing ? () => router.back() : retry}
              testID="signin-retry"
            />
          </View>
        ) : null}
        {!pageError && signIn.method === 'oauth' ? (
          <View style={styles.centered} testID="signin-oauth-browser">
        <Text style={styles.note}>{connectorName} sign-in opens in your browser. Return here after granting access.</Text>
        <Button label={`Continue with ${connectorName}`} onPress={() => void openBrowser()} testID="signin-open-external" />
      </View>
        ) : !pageError && WebView && signIn.url ? (
          React.createElement(WebView, { key: `${signIn.url}:${attempt}`, onLoadEnd: () => setPageLoaded(true), onError: () => setPageError('The sign-in page could not load. Retry or open it in your browser.'), onHttpError: () => setPageError('The sign-in page could not load. Retry or open it in your browser.'), source: { uri: signIn.url }, style: styles.webView, javaScriptEnabled: true, domStorageEnabled: true, testID: 'signin-webview' })
        ) : fallback ? (
          <View style={styles.centered}><Text style={styles.note}>Finish sign-in in the browser, then return here.</Text></View>
        ) : (
          <ScrollView contentContainerStyle={styles.centered}>{!pageError && !observed.error ? <ActivityIndicator testID="signin-webview-loading" /> : null}<Button label="Open in browser" disabled={!signIn.url} onPress={() => void openBrowser()} testID="signin-open-external" /></ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create(theme => ({
  returnScreen: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.buzz.bgTerminal },
  error: { ...Typography.default(), color: theme.buzz.dialogDanger },
  scrim: { flex: 1, justifyContent: 'center' },
  card: { flex: 1, marginHorizontal: 16, borderRadius: theme.buzz.radius, overflow: 'hidden', backgroundColor: theme.buzz.bgTerminal },
  centered: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  note: { ...theme.buzz.type.body, color: theme.buzz.textSecondary, textAlign: 'center' },
  webView: { flex: 1 },
}));
