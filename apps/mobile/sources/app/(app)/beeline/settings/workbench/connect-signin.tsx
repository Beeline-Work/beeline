import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as WebBrowser from 'expo-web-browser';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { useSandboxWebView } from '@/components/buzz/sandbox-webview';
import { getWorkbenchSource } from '@/buzz/workbench-source';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const SIGN_IN_POLL_MS = 1500;

/**
 * Squire sign-in — a FULL-SCREEN in-app browser (captain ruling, steer-2):
 * the complete sign-in sequence (Google's own windows, redirects, email
 * checks) runs inside a JavaScript-enabled WebView pushed over the connect
 * screen, never inside the step list. The screen polls the connector's
 * install state and dismisses itself the moment the helper reports
 * `connected`. Where a native WebView cannot load (web), it falls back to
 * the system browser and asks the user to return here.
 */
export default function ConnectorSignInScreen() {
  const params = useLocalSearchParams<{
    workspaceId?: string | string[];
    viewerId?: string | string[];
    connectorId?: string | string[];
    url?: string | string[];
    method?: string | string[];
  }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const connectorId = firstParam(params.connectorId) ?? 'trusty-squire';
  const url = firstParam(params.url) ?? '';
  const method = firstParam(params.method) ?? 'streamed';
  const webView = useSandboxWebView();
  const [fellBack, setFellBack] = useState(false);
  const dismissedRef = useRef(false);

  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    router.replace('/beeline/settings/workbench' as unknown as Href);
  }, []);

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
    if (method === 'oauth') {
      await WebBrowser.openAuthSessionAsync(url);
    } else {
      await WebBrowser.openBrowserAsync(url);
    }
    setFellBack(true);
  }, [method, url]);

  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  })();

  return (
    <View style={styles.container}>
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
          <Text style={styles.title}>Sign in to Squire</Text>
          {host ? <Text style={styles.subtitle}>{host}</Text> : null}
        </View>
      </View>
      {webView && url ? (
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
