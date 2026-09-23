import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as WebBrowser from 'expo-web-browser';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { AnimatedBlurBackdrop } from '@/components/AnimatedOverlay';
import { useSandboxWebView } from '@/components/buzz/sandbox-webview';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { connectorOfferCompletionRoute } from '@/buzz/connector-offer-ceremony';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const SIGN_IN_POLL_MS = 1500;

/**
 * Connector sign-in — an in-app browser OVERLAY (captain rulings, steer-2 and
 * the post-connect steer): the complete sign-in sequence (Google's own
 * windows, redirects, email checks) runs inside a JavaScript-enabled
 * WebView rendered over the connect screen in a card that occupies most —
 * never all — of the screen, with the underlying screen frosted/muted
 * behind it. The screen polls the connector's install state and dismisses
 * itself the moment the helper reports `connected`. Where a native WebView
 * cannot load (web), it falls back to the system browser and asks the user
 * to return here.
 */
export default function ConnectorSignInScreen() {
  const params = useLocalSearchParams<{
    workspaceId?: string | string[];
    viewerId?: string | string[];
    connectorId?: string | string[];
    connectorName?: string | string[];
    url?: string | string[];
    method?: string | string[];
    offerId?: string | string[];
    roomId?: string | string[];
  }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const connectorId = firstParam(params.connectorId) ?? 'trusty-squire';
  const connectorName = firstParam(params.connectorName) ?? 'Trusty Squire';
  const url = firstParam(params.url) ?? '';
  const method = firstParam(params.method) ?? 'streamed';
  const roomId = firstParam(params.roomId);
  const webView = useSandboxWebView();
  const [fellBack, setFellBack] = useState(false);
  const dismissedRef = useRef(false);
  const insets = useSafeAreaInsets();

  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    router.replace(connectorOfferCompletionRoute(roomId) as unknown as Href);
  }, [roomId]);

  useEffect(() => {
    if (!workspaceId) return;
    const poll = setInterval(() => {
      void getWorkbenchSource()
        .readInstallState({ workspaceId, connectorId })
        .then((state) => {
          if (state?.connected) dismiss();
        })
        .catch(() => undefined);
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(poll);
  }, [connectorId, dismiss, workspaceId]);

  const openExternally = useCallback(async () => {
    if (!url) return;
    await WebBrowser.openBrowserAsync(url);
    setFellBack(true);
  }, [url]);

  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  })();

  return (
    <View style={styles.scrim} testID="signin-overlay">
      {/* Frosted glass over the underlying connect screen; tapping it is not
          a close — the sign-in must settle on its own terms. */}
      <AnimatedBlurBackdrop interactive={false} blurIntensity={48} />
      <View style={[styles.card, { marginTop: insets.top + 24, marginBottom: insets.bottom + 24 }]} testID="signin-card">
      <View style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="Close sign-in"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.backButton}
          testID="signin-close"
        >
          <Text style={styles.backButtonText}>✕</Text>
        </TouchableOpacity>
        <View style={styles.titleBlock}>
          <Text style={styles.title} testID="signin-title">
            Sign in to {connectorName}
          </Text>
          {host ? <Text style={styles.subtitle}>{host}</Text> : null}
        </View>
      </View>
      {method === 'oauth' ? (
        <View style={styles.centered} testID="signin-oauth-browser">
          <Text style={styles.note}>Google sign-in opens in your browser. Return here after granting access.</Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => void openExternally()}
            style={styles.fallbackButton}
            testID="signin-open-external"
          >
            <Text style={styles.fallbackText}>Continue with Google</Text>
          </TouchableOpacity>
        </View>
      ) : webView && url ? (
        // JS-enabled on purpose: the sign-in sequence itself must run.
        React.createElement(webView, {
          source: { uri: url },
          style: styles.webView,
          javaScriptEnabled: true,
          domStorageEnabled: true,
          testID: 'signin-webview',
        })
      ) : webView && !url ? (
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
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    header: {
      minHeight: 66,
      paddingHorizontal: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backButtonText: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    titleBlock: { flex: 1, gap: 2 },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    subtitle: { ...Typography.mono(), ...hull.type.meta, color: hull.textMuted },
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
