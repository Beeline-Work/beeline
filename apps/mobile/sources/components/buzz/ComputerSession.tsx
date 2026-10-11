import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { useSandboxWebView } from '@/components/buzz/sandbox-webview';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Modal } from '@/modal';
import { openComputerInDesktopWorkPane } from '@/buzz/desktop-computer-pane';
import { openExternalUrl } from '@/utils/open-external-url';

export type ComputerSessionView = NonNullable<RoomViewMessage['computerSession']> & { access?: string };

function ComputerStream({ session, preview = false, onEnded }: { session: ComputerSessionView; preview?: boolean; onEnded?: () => void }) {
  const WebView = useSandboxWebView();
  const streamUrl = new URL(session.url);
  if (session.access) streamUrl.searchParams.set('access', session.access);
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
  if (session.status === 'ended') return <View style={styles.ended} testID="computer-session-ended"><Text style={styles.endedText}>Browser session ended</Text></View>;
  if (!session.access) return <View style={styles.ended}><Text style={styles.endedText}>Connecting to browser…</Text></View>;
  if (Platform.OS === 'web') return React.createElement('iframe', {
    src: url,
    title: session.title,
    style: { width: '100%', height: '100%', border: 0, pointerEvents: preview ? 'none' : 'auto' },
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
  const [access, setAccess] = React.useState<string | null>(session.access ?? null);
  React.useEffect(() => {
    if (session.status !== 'live' || session.access) return;
    let mounted = true;
    void monolithPhoneOperation('openComputerSession', { id: session.id })
      .then(({ access: token }) => { if (mounted) setAccess(token); })
      .catch(() => { if (mounted) setAccess(null); });
    return () => { mounted = false; };
  }, [session.id, session.status, session.access]);
  const open = async () => {
    if (!access || session.status !== 'live') return;
    let freshAccess: string;
    try {
      freshAccess = (await monolithPhoneOperation('openComputerSession', { id: session.id })).access;
    } catch {
      setAccess(null);
      return;
    }
    setAccess(freshAccess);
    const permitted = { ...session, access: freshAccess };
    if (isDesktop && openComputerInDesktopWorkPane(permitted)) return;
    Modal.show({ component: ComputerSessionViewer, props: { session: permitted }, placement: 'fill' });
  };
  return <View style={styles.card} testID={`computer-session-card-${session.status}`}>
    {session.status === 'live' && access ? <Pressable onPress={() => void open()} accessibilityRole="button" accessibilityLabel={`Open ${session.title} browser`}>
      <View style={styles.preview} pointerEvents="none"><ComputerStream session={{ ...session, access }} preview /></View>
      <View style={styles.caption}><Text numberOfLines={1} style={styles.title}>{session.title}</Text>
        <Text style={styles.kind}>Live browser</Text></View>
    </Pressable> : <View style={styles.caption}><Text numberOfLines={1} style={styles.title}>{session.title}</Text>
      <Text style={styles.kind}>{session.status === 'ended' ? 'Session ended' : 'Live browser'}</Text></View>}
    {session.status === 'live' && access ? <View style={styles.footer}>
      <Pressable onPress={() => void open()} accessibilityRole="button" accessibilityLabel="Open live browser" testID="computer-session-open"><Text style={styles.link}>Open live browser</Text></Pressable>
    </View> : null}
  </View>;
}

/** Full area of the artifact viewer, with only the two rounded controls. */
export function ComputerSessionViewer({ session, onClose }: { session: ComputerSessionView; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [ended, setEnded] = React.useState(session.status === 'ended');
  React.useEffect(() => { if (session.status === 'ended') setEnded(true); }, [session.status]);
  const shownSession = ended ? { ...session, status: 'ended' as const } : session;
  const openInBrowser = async () => {
    if (ended || !session.access) return;
    try {
      const { access } = await monolithPhoneOperation('openComputerSession', { id: session.id });
      const url = new URL(session.url);
      url.searchParams.set('access', access);
      await openExternalUrl(url.toString());
    } catch {
      Modal.alert('Could not open browser', 'The live browser is unavailable. Try again.');
    }
  };
  return <View style={styles.viewer} testID="computer-session-viewer">
    <ComputerStream session={shownSession} onEnded={() => setEnded(true)} />
    <View style={[styles.controls, { top: insets.top + 12 }]}>
      {!ended && session.access ? <Pressable style={styles.browserControl} onPress={() => void openInBrowser()} accessibilityRole="button" accessibilityLabel="Open in browser" testID="computer-session-open-browser"><Text style={styles.controlText}>Open in browser ↗</Text></Pressable> : null}
      <Pressable style={styles.control} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close browser" testID="computer-session-close"><Text style={styles.controlText}>✕</Text></Pressable>
    </View>
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  card: { width: '100%', marginTop: theme.buzz.transcriptCard.marginTop, borderWidth: 1, borderColor: theme.buzz.borderStrong, borderRadius: theme.buzz.transcriptCard.cornerRadius, overflow: 'hidden' },
  preview: { height: 218, backgroundColor: theme.buzz.bgBase },
  stream: { width: '100%', height: '100%', backgroundColor: theme.buzz.bgBase },
  caption: { paddingHorizontal: theme.buzz.transcriptCard.side, paddingVertical: theme.buzz.space.sm, gap: theme.buzz.space.xs },
  title: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  kind: { ...theme.buzz.type.machine, color: theme.buzz.ledgerQuiet },
  footer: { minHeight: theme.buzz.transcriptCard.footerMinHeight, paddingHorizontal: theme.buzz.transcriptCard.side, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: theme.buzz.border },
  link: { ...theme.buzz.type.body, color: theme.buzz.accent },
  viewer: { flex: 1, backgroundColor: theme.buzz.bgBase },
  controls: { position: 'absolute', right: 12, flexDirection: 'row', gap: 8 },
  control: { width: 42, height: 42, borderRadius: 14, borderWidth: 1, borderColor: theme.buzz.borderStrong, backgroundColor: theme.buzz.bgBase, alignItems: 'center', justifyContent: 'center' },
  browserControl: { height: 42, paddingHorizontal: theme.buzz.space.sm, borderRadius: 14, borderWidth: 1, borderColor: theme.buzz.borderStrong, backgroundColor: theme.buzz.bgBase, alignItems: 'center', justifyContent: 'center' },
  controlText: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  ended: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.buzz.bgBase },
  endedText: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
}));
