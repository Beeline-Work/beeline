import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AttachmentReference } from '@beeline/buzz-client';
import { runnableArtifactUrl } from '@/buzz/artifact-link';
import { useSandboxWebView, useSandboxWebViewStatus } from './sandbox-webview';
import { Button } from './Button';

/** Deliberately no message bridge or injected script, including in error states. */
export function RunnableArtifact({ attachment }: { attachment: AttachmentReference }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [navigationStopped, setNavigationStopped] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef(false);
  const WebView = useSandboxWebView();
  const status = useSandboxWebViewStatus();
  useEffect(() => {
    let live = true;
    setUrl(undefined);
    setFailed(false);
    setNavigationStopped(false);
    loaded.current = false;
    void runnableArtifactUrl(attachment).then(
      (value) => {
        if (live) setUrl(value);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [attachment.url, attempt]);
  if (navigationStopped) {
    return (
      <View style={styles.placeholder} testID="runnable-artifact-navigation-stopped">
        <Text style={styles.text}>This page tried to open another page and was closed.</Text>
        <Button
          label="Reopen"
          onPress={() => setAttempt((value) => value + 1)}
          testID="runnable-artifact-reopen"
        />
      </View>
    );
  }
  if (failed || (Platform.OS !== 'web' && status === 'unavailable')) {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.text}>Stopped. Close and reopen it to try again.</Text>
      </View>
    );
  }
  if (!url || (Platform.OS !== 'web' && !WebView)) {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.text}>Opening…</Text>
      </View>
    );
  }
  if (Platform.OS === 'web') {
    const embeddedUrl = new URL(url);
    embeddedUrl.searchParams.set('embed', '1');
    return React.createElement('iframe', {
      src: embeddedUrl.href,
      sandbox: 'allow-scripts',
      referrerPolicy: 'no-referrer',
      allow: "camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'",
      title: attachment.title ?? attachment.name,
      style: { width: '100%', height: '100%', border: 0, flex: 1 },
      'data-testid': 'runnable-artifact',
      onLoad: (event: { currentTarget: HTMLIFrameElement }) => {
        if (!loaded.current) {
          loaded.current = true;
          event.currentTarget.contentWindow?.postMessage('beeline-start-game', '*');
          return;
        }
        // Hide synchronously; React then removes the browsing context. This
        // handler belongs to the trusted parent, outside the opaque frame.
        event.currentTarget.style.visibility = 'hidden';
        setNavigationStopped(true);
      },
    });
  }
  const NativeWebView = WebView!;
  return (
    <NativeWebView
      source={{ uri: url }}
      javaScriptEnabled
      // Whitelist every scheme so the library always consults our guard instead
      // of handing a rejected link to Linking.openURL before calling the guard.
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={(request: { url: string }) => {
        try {
          return new URL(request.url).origin === new URL(url).origin;
        } catch {
          return false;
        }
      }}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      domStorageEnabled={false}
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      geolocationEnabled={false}
      mediaCapturePermissionGrantType="deny"
      mediaPlaybackRequiresUserAction
      allowsFullscreenVideo={false}
      mixedContentMode="never"
      onRenderProcessGone={() => setFailed(true)}
      onContentProcessDidTerminate={() => setFailed(true)}
      onError={() => setFailed(true)}
      onHttpError={() => setFailed(true)}
      style={styles.frame}
      testID="runnable-artifact"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: { flex: 1 },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.buzz.space.md,
  },
  text: { ...theme.buzz.type.body, color: theme.buzz.textSecondary },
}));
