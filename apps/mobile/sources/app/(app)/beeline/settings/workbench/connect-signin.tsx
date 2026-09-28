import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StyleSheet } from 'react-native-unistyles';
import * as WebBrowser from 'expo-web-browser';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { AnimatedBlurBackdrop } from '@/components/AnimatedOverlay';
import { PageHeader } from '@/components/buzz/PageHeader';
import { useSandboxWebView } from '@/components/buzz/sandbox-webview';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { connectorOfferCompletionRoute } from '@/buzz/connector-offer-ceremony';
import { GOOGLE_ACCOUNT_CONNECTOR_ID } from '@beeline/api-contract/workbench';
import { authSessionOptions } from '@/auth/auth-session';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const SIGN_IN_POLL_MS = 1500;
const GOOGLE_RETURN_URI = 'beeline://beeline/settings/workbench/connect-signin';
const GOOGLE_RETURN_KEY = 'beeline.google-auth-return.v1';

function dismissGoogleBrowser() {
  // Android's Custom Tabs polyfill has no native dismiss function. Its
  // separate, no-history task is closed by returning to Beeline; iOS/web can
  // also dismiss the session directly.
  try { WebBrowser.dismissAuthSession(); } catch { /* Android has no dismiss API. */ }
}

async function clearGoogleReturn(state?: string) {
  if (!state) return;
  const stored = await AsyncStorage.getItem(GOOGLE_RETURN_KEY);
  if (!stored) return;
  try {
    if ((JSON.parse(stored) as { state?: string }).state === state)
      await AsyncStorage.removeItem(GOOGLE_RETURN_KEY);
  } catch { await AsyncStorage.removeItem(GOOGLE_RETURN_KEY); }
}

/**
 * Connector sign-in keeps streamed helper pages inside the frosted WebView
 * overlay. Google consent uses a platform auth session so its server callback
 * returns to Beeline and closes Android's separate Custom Tab task. The
 * screen also reads install state on foreground and while it remains open so
 * completed, canceled, or expired attempts do not leave an orphaned session.
 */
export default function ConnectorSignInScreen() {
  const params = useLocalSearchParams<{
    workspaceId?: string | string[];
    viewerId?: string | string[];
    connectorId?: string | string[];
    connectorName?: string | string[];
    machineName?: string | string[];
    url?: string | string[];
    method?: string | string[];
    offerId?: string | string[];
    roomId?: string | string[];
    oauthReturn?: string | string[];
  }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const connectorId = firstParam(params.connectorId) ?? 'trusty-squire';
  const connectorName = firstParam(params.connectorName) ?? 'Trusty Squire';
  const machineName = firstParam(params.machineName);
  const url = firstParam(params.url) ?? '';
  const method = firstParam(params.method) ?? 'streamed';
  const [currentSignIn, setCurrentSignIn] = useState({ url, method });
  const roomId = firstParam(params.roomId);
  const returnState = firstParam(params.oauthReturn);
  const webView = useSandboxWebView();
  const [fellBack, setFellBack] = useState(false);
  const dismissedRef = useRef(false);
  const openedUrlRef = useRef<string | null>(null);
  const authOpenRef = useRef(false);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!returnState) return;
    let live = true;
    void AsyncStorage.getItem(GOOGLE_RETURN_KEY).then(async (stored) => {
      if (!live) return;
      let destination: ReturnType<typeof connectorOfferCompletionRoute> | '/beeline/channels' = '/beeline/channels';
      if (stored) {
        try {
          const record = JSON.parse(stored) as { state: string; roomId?: string };
          if (record.state === returnState) {
            destination = connectorOfferCompletionRoute(record.roomId);
            await AsyncStorage.removeItem(GOOGLE_RETURN_KEY);
          }
        } catch { /* A stale return record cannot authorize a destination. */ }
      }
      if (!live) return;
      dismissedRef.current = true;
      dismissGoogleBrowser();
      router.replace(destination as Href);
    }).catch(() => {
      if (live) router.replace('/beeline/channels' as Href);
    });
    return () => { live = false; };
  }, [returnState]);

  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    router.replace(connectorOfferCompletionRoute(roomId) as unknown as Href);
  }, [roomId]);

  // A failed attempt, or a row with no sign-in page left, has nothing for
  // this overlay to show: return to the connect screen, which shows Retry.
  const returnToConnect = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    router.back();
  }, []);

  useEffect(() => {
    if (!workspaceId || returnState) return;
    let live = true;
    const poll = setInterval(() => {
      void getWorkbenchSource()
        .readInstallState({ workspaceId, connectorId })
        .then((state) => {
          if (!live) return;
          if (state?.connected) {
            if (connectorId === GOOGLE_ACCOUNT_CONNECTOR_ID) dismissGoogleBrowser();
            dismiss();
          }
          else if (state?.signIn &&
            (connectorId === GOOGLE_ACCOUNT_CONNECTOR_ID ||
              !state.steps?.some((step) => step.status === 'failed'))) {
            const { url: next, method: nextMethod } = state.signIn;
            setCurrentSignIn((shown) =>
              shown.url === next && shown.method === nextMethod ? shown : { url: next, method: nextMethod });
          }
          else if (connectorId === GOOGLE_ACCOUNT_CONNECTOR_ID && state) {
            dismissGoogleBrowser();
            dismiss();
          }
          else if (state) returnToConnect();
        })
        .catch(() => undefined);
    }, SIGN_IN_POLL_MS);
    return () => { live = false; clearInterval(poll); };
  }, [connectorId, dismiss, returnState, returnToConnect, workspaceId]);

  const host = (() => {
    try {
      return new URL(currentSignIn.url).host;
    } catch {
      return '';
    }
  })();
  const oauthState = (() => {
    try { return new URL(currentSignIn.url).searchParams.get('state') ?? undefined; }
    catch { return undefined; }
  })();
  const googleAuth = host === 'accounts.google.com';

  useEffect(() => {
    if (!googleAuth || returnState) return;
    let live = true;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void getWorkbenchSource().readInstallState({ workspaceId, connectorId })
        .then((install) => {
          if (live && install && !install.signIn) {
            dismissGoogleBrowser();
            dismiss();
          }
        }).catch(() => undefined);
    });
    return () => { live = false; subscription.remove(); };
  }, [connectorId, dismiss, googleAuth, returnState, workspaceId]);

  // Android may return from a Custom Tab with `opened`, not a close result.
  // Leaving this screen still retires its pending Google attempt.
  useEffect(() => () => {
    if (googleAuth && !returnState) {
      void getWorkbenchSource().cancelGoogleSignIn({ connectorId,
        ...(oauthState ? { state: oauthState } : {}) }).catch(() => undefined);
    }
  }, [connectorId, googleAuth, oauthState, returnState]);

  const openExternally = useCallback(async () => {
    if (!currentSignIn.url || authOpenRef.current) return;
    if (googleAuth) {
      authOpenRef.current = true;
      try {
        if (oauthState) await AsyncStorage.setItem(GOOGLE_RETURN_KEY,
          JSON.stringify({ state: oauthState, ...(roomId ? { roomId } : {}) }));
        const result = await WebBrowser.openAuthSessionAsync(currentSignIn.url,
          GOOGLE_RETURN_URI, authSessionOptions(Platform.OS, GOOGLE_RETURN_URI));
        if (result.type !== 'success') {
          const cancelled = await getWorkbenchSource().cancelGoogleSignIn({ connectorId,
            ...(oauthState ? { state: oauthState } : {}) }).catch(() => false);
          // Android can report `dismiss` when AppState becomes active a few
          // milliseconds before Linking delivers a successful callback. A
          // settled server state returns false: keep its Room return record.
          if (cancelled) await clearGoogleReturn(oauthState);
        }
      } catch {
        await getWorkbenchSource().cancelGoogleSignIn({ connectorId,
          ...(oauthState ? { state: oauthState } : {}) }).catch(() => undefined);
        await clearGoogleReturn(oauthState).catch(() => undefined);
      } finally {
        authOpenRef.current = false;
        dismissGoogleBrowser();
        dismiss();
      }
      return;
    }
    await WebBrowser.openBrowserAsync(currentSignIn.url);
    setFellBack(true);
  }, [connectorId, currentSignIn.url, dismiss, googleAuth, oauthState, roomId]);

  useEffect(() => {
    if (!googleAuth || returnState || !currentSignIn.url ||
        openedUrlRef.current === currentSignIn.url) return;
    openedUrlRef.current = currentSignIn.url;
    void openExternally();
  }, [currentSignIn.url, googleAuth, openExternally, returnState]);

  return (
    <View style={styles.scrim} testID="signin-overlay">
      {/* Frosted glass over the underlying connect screen; tapping it is not
          a close — the sign-in must settle on its own terms. */}
      <AnimatedBlurBackdrop interactive={false} blurIntensity={48} />
      <View style={[styles.card, { marginTop: insets.top + 24, marginBottom: insets.bottom + 24 }]} testID="signin-card">
      <PageHeader
        backAccessibilityLabel="Close sign-in"
        eyebrow="Workbench"
        meta={[machineName, host].filter(Boolean).join(' · ') || undefined}
        onBack={() => {
          if (googleAuth) {
            dismissedRef.current = true;
            void getWorkbenchSource().cancelGoogleSignIn({ connectorId,
              ...(oauthState ? { state: oauthState } : {}) })
              .then((cancelled) => {
                if (cancelled) void clearGoogleReturn(oauthState).catch(() => undefined);
              })
              .catch(() => undefined)
              .finally(() => {
                dismissGoogleBrowser();
                router.back();
              });
          } else router.back();
        }}
        testID="signin-header"
        title={`Sign in to ${connectorName}`}
      />
      {currentSignIn.method === 'oauth' ? (
        <View style={styles.centered} testID="signin-oauth-browser">
          <Text style={styles.note}>{connectorName} sign-in opens in your browser. Return here after granting access.</Text>
          {host === 'accounts.google.com' ? (
            <Text style={styles.note}>
              Google may show an unverified-app warning. Choose Advanced, then Go to Beeline to continue.
            </Text>
          ) : null}
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => void openExternally()}
            style={styles.fallbackButton}
            testID="signin-open-external"
          >
            <Text style={styles.fallbackText}>Continue with {connectorName}</Text>
          </TouchableOpacity>
        </View>
      ) : webView && currentSignIn.url ? (
        // JS-enabled on purpose: the sign-in sequence itself must run.
        React.createElement(webView, {
          source: { uri: currentSignIn.url },
          style: styles.webView,
          javaScriptEnabled: true,
          domStorageEnabled: true,
          testID: 'signin-webview',
        })
      ) : webView && !currentSignIn.url ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>No sign-in page was reported</Text>
        </View>
      ) : webView === null && fellBack ? (
        <View style={styles.centered} testID="signin-fallback">
          <Text style={styles.note}>
            Finish the sign-in in the browser you just opened, then come back — this screen closes
            itself when the helper is connected.
          </Text>
        </View>
      ) : webView === null ? (
        <View style={styles.centered}>
          <ActivityIndicator testID="signin-webview-loading" />
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => void openExternally()}
            style={styles.fallbackButton}
            testID="signin-open-external"
          >
            <Text style={styles.fallbackText}>Open in browser instead</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.centered}>
          <ActivityIndicator testID="signin-webview-loading" />
        </ScrollView>
      )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    // The overlay's own floor: transparent so the frosted backdrop reads
    // over the connect screen beneath this modal route.
    scrim: { flex: 1, justifyContent: 'space-between' },
    // Most of the screen, never full-bleed.
    card: {
      flex: 1,
      marginHorizontal: '5%',
      backgroundColor: hull.bgTerminal,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      borderRadius: hull.radius,
      overflow: 'hidden',
    },
    webView: { flex: 1, backgroundColor: hull.bgTerminal },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: hull.space.md, padding: hull.space.xl },
    note: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted, textAlign: 'center' },
    errorText: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger },
    fallbackButton: {
      minHeight: hull.layout.row,
      borderWidth: 1,
      borderColor: hull.border,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: hull.space.md,
    },
    fallbackText: { ...Typography.default(), ...hull.type.body, color: hull.textMuted },
  };
});
