import React from 'react';
import { Image, Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { useSandboxWebView } from '@/components/buzz/sandbox-webview';
import { openExternalUrl } from '@/utils/open-external-url';
import { Modal } from '@/modal';
import { openComputerInDesktopWorkPane } from '@/buzz/desktop-computer-pane';

export type ComputerSessionView = NonNullable<RoomViewMessage['computerSession']>;

function ComputerStream({ session, preview = false, onEnded }: { session: ComputerSessionView; preview?: boolean; onEnded?: () => void }) {
  const WebView = useSandboxWebView();
  const streamUrl = new URL(session.url);
  streamUrl.searchParams.set('embedded', '1');
  if (preview) streamUrl.searchParams.set('preview', '1');
  const url = streamUrl.toString();
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !onEnded) return;
    const origin = new URL(session.url).origin;
    const handle = (event: MessageEvent) => {
      if (event.origin !== origin || event.data?.type !== 'computer-ended' || event.data.id !== session.id) return;
      onEnded();
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [onEnded, session.id, session.url]);
  if (session.status === 'ended') return (
    <View style={styles.ended} testID="computer-session-ended">
      <Image source={{ uri: session.lastFrameUrl }} resizeMode="contain" style={styles.lastFrame} />
      <View style={styles.endedShade}><Text style={styles.endedText}>Browser session ended</Text></View>
    </View>
  );
  if (Platform.OS === 'web') return React.createElement('iframe', {
    src: url,
    title: session.title,
    style: { width: '100%', height: '100%', border: 0, background: '#1b1320', pointerEvents: preview ? 'none' : 'auto' },
    'data-testid': preview ? 'computer-session-preview-frame' : 'computer-session-view-frame',
  });
  if (WebView) return <WebView source={{ uri: url }} javaScriptEnabled domStorageEnabled
    onMessage={onEnded ? (event: { nativeEvent: { data: string } }) => {
      try { const message = JSON.parse(event.nativeEvent.data) as { type?: string; id?: string };
        if (message.type === 'computer-ended' && message.id === session.id) onEnded();
      } catch { /* Ignore unrelated page messages. */ }
    } : undefined}
    scrollEnabled={false} style={styles.stream} testID={preview ? 'computer-session-preview-webview' : 'computer-session-view-webview'} />;
  return <View style={styles.ended}><Text style={styles.endedText}>Opening browser…</Text></View>;
}

/** The live card uses a real stream while mounted; it never snapshots or polls. */
export function ComputerSessionCard({ session, isDesktop }: { session: ComputerSessionView; isDesktop?: boolean }) {
  const open = () => {
    if (isDesktop && openComputerInDesktopWorkPane(session)) return;
    Modal.show({ component: ComputerSessionViewer, props: { session }, placement: 'fill' });
  };
  return <View style={styles.card} testID={`computer-session-card-${session.status}`}>
    <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`Open ${session.title} browser`}>
      <View style={styles.preview} pointerEvents="none"><ComputerStream session={session} preview /></View>
      <View style={styles.caption}><Text numberOfLines={1} style={styles.title}>{session.title}</Text>
        <Text style={styles.kind}>{session.status === 'live' ? 'Live browser' : 'Session ended'}</Text></View>
    </Pressable>
    <View style={styles.footer}>
      {session.status === 'live' ? <Pressable onPress={() => void openExternalUrl(session.url)} accessibilityRole="link" accessibilityLabel="Open browser in system browser" testID="computer-session-open-browser"><Text style={styles.link}>Open in browser ↗</Text></Pressable> : null}
      <Pressable onPress={open} style={session.status === 'ended' ? styles.endedOpen : undefined} accessibilityRole="button" accessibilityLabel="Open browser viewer" testID="computer-session-open"><Text style={styles.link}>Open</Text></Pressable>
    </View>
  </View>;
}

/** Full area of the artifact viewer, with only the two rounded controls. */
export function ComputerSessionViewer({ session, onClose }: { session: ComputerSessionView; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [ended, setEnded] = React.useState(session.status === 'ended');
  React.useEffect(() => { if (session.status === 'ended') setEnded(true); }, [session.status]);
  const shownSession = ended ? { ...session, status: 'ended' as const } : session;
  return <View style={styles.viewer} testID="computer-session-viewer">
    <ComputerStream session={shownSession} onEnded={() => setEnded(true)} />
    <View style={[styles.controls, { top: insets.top + 12 }]}>
      <Pressable style={styles.control} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close browser" testID="computer-session-close"><Text style={styles.controlText}>✕</Text></Pressable>
      {!ended ? <Pressable style={styles.control} onPress={() => void openExternalUrl(session.url)} accessibilityRole="link" accessibilityLabel="Open browser in system browser" testID="computer-session-view-open-browser"><Text style={styles.controlText}>↗</Text></Pressable> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  card: { width: '100%', marginTop: theme.buzz.transcriptCard.marginTop, borderWidth: 1, borderColor: theme.buzz.borderStrong, borderRadius: theme.buzz.transcriptCard.cornerRadius, overflow: 'hidden' },
  preview: { height: 218, backgroundColor: '#1b1320' },
  stream: { width: '100%', height: '100%', backgroundColor: '#1b1320' },
  caption: { paddingHorizontal: theme.buzz.transcriptCard.side, paddingVertical: theme.buzz.space.sm, gap: 3 },
  title: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  kind: { ...theme.buzz.type.machine, color: theme.buzz.ledgerQuiet },
  footer: { minHeight: theme.buzz.transcriptCard.footerMinHeight, paddingHorizontal: theme.buzz.transcriptCard.side, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: theme.buzz.border },
  endedOpen: { marginLeft: 'auto' },
  link: { ...theme.buzz.type.body, color: theme.buzz.accent },
  viewer: { flex: 1, backgroundColor: '#1b1320' },
  controls: { position: 'absolute', right: 12, flexDirection: 'row', gap: 8 },
  control: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: theme.buzz.borderStrong, backgroundColor: theme.buzz.bgBase, alignItems: 'center', justifyContent: 'center' },
  controlText: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  ended: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: '#1b1320' },
  lastFrame: { width: '100%', height: '100%' },
  endedShade: { position: 'absolute', bottom: 18, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: '#261a2add' },
  endedText: { ...theme.buzz.type.body, color: '#f6edf4' },
}));
