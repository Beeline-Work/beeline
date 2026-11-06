import { IndexRow } from '@/components/buzz/IndexRow';
import { useArtifactRecoveryGeneration } from '@/buzz/use-artifact-recovery';
import { funnelOnboarding } from '@/auth/signin-funnel';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AttachmentReference } from '@beeline/buzz-client';
import { runnableArtifactUrl } from '@/buzz/artifact-link';
import { mediaIdFromUrl } from '@/buzz/artifact';
import { subscribeMediaCacheBoundary } from '@/buzz/media-cache-connection';
import { useSandboxWebView, useSandboxWebViewStatus } from './sandbox-webview';
import { Button } from './Button';

/** Deliberately no message bridge or injected script, including in error states. */
export function RunnableArtifact({ attachment }: { attachment: AttachmentReference }) {
  const recovery = useArtifactRecoveryGeneration();
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [navigationStopped, setNavigationStopped] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef(false);
  const [pageLoaded, setPageLoaded] = useState(false);
  const WebView = useSandboxWebView();
  const status = useSandboxWebViewStatus();
  useEffect(() => {
    const started = Date.now();
    const artifactId = mediaIdFromUrl(attachment.url);
    if (!artifactId) return;
    void funnelOnboarding('game_viewer_opened', undefined, artifactId);
    return () => { void funnelOnboarding('game_viewer_closed', Math.min(86_400_000, Date.now() - started), artifactId); };
  }, [attachment.url]);
  useEffect(() => {
    let live = true;
    const objectId = mediaIdFromUrl(attachment.url);
    const stopAuthority = subscribeMediaCacheBoundary(event => {
      const objectId = mediaIdFromUrl(attachment.url);
      live = false; setUrl(undefined); setFailed(true);
    });
    setUrl(undefined);
    setFailed(false);
    setNavigationStopped(false);
    setPageLoaded(false);
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
      live = false; stopAuthority();
    };
  }, [attachment.url, attempt, recovery]);
  if (navigationStopped) {
    return (
      <View style={styles.placeholder} testID="runnable-artifact-navigation-stopped">
        <Text style={styles.text}>This page tried to open another page and was closed.</Text>
        <Button
          label="Reopen"
          onPress={() => {
            const objectId = mediaIdFromUrl(attachment.url);
            setAttempt((value) => value + 1);
          }}
          testID="runnable-artifact-reopen"
        />
      </View>
    );
  }
  if (failed || (Platform.OS !== 'web' && status === 'unavailable')) {
    return (
      <View style={styles.failureInset} >
        <IndexRow inset="flush" title="Artifact stopped" description={"Stopped. Close and reopen it to try again."} />
      </View>
    );
  }
  if (!url || (Platform.OS !== 'web' && !WebView)) {
    return (
      <View style={styles.placeholder} testID="runnable-artifact-loading">
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );
  }
  // The frame stays mounted under the status so its load event can fire.
  const loadingOverlay = pageLoaded ? null : (
    <View style={styles.loadingOverlay} testID="runnable-artifact-loading">
      <Text style={styles.loadingText}>Loading…</Text>
    </View>
  );
  if (Platform.OS === 'web') {
    const embeddedUrl = new URL(url);
    embeddedUrl.searchParams.set('embed', '1');
    const frame = React.createElement('iframe', {
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
          setPageLoaded(true);
          event.currentTarget.contentWindow?.postMessage('beeline-start-game', '*');
          return;
        }
        // Hide synchronously; React then removes the browsing context. This
        // handler belongs to the trusted parent, outside the opaque frame.
        event.currentTarget.style.visibility = 'hidden';
        setNavigationStopped(true);
      },
    });
    return (
      <View style={styles.stage}>
        {frame}
        {loadingOverlay}
      </View>
    );
  }
  const NativeWebView = WebView!;
  return (
    <View style={styles.stage}>
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
        onLoadEnd={() => setPageLoaded(true)}
        style={styles.frame}
        testID="runnable-artifact"
      />
      {loadingOverlay}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  failureInset: { paddingHorizontal: theme.buzz.roomList.edge },
  frame: { flex: 1 },
  stage: { flex: 1 },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.buzz.bgBase,
  },
  // Same placeholder text style as the plain artifact viewer's "Loading…".
  loadingText: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.buzz.space.md,
  },
  text: { ...theme.buzz.type.body, color: theme.buzz.textSecondary },
}));
