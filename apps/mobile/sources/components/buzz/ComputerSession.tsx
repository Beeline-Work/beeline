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
import { ViewerConversationDock } from '@/components/buzz/ViewerConversationDock';
import { currentViewerConversation } from '@/buzz/viewer-conversation';

export type ComputerSessionView = NonNullable<RoomViewMessage['computerSession']> & { access?: string; agentHandle?: string };

function ComputerStream({ session, preview = false, onEnded, captureRef }: {
  session: ComputerSessionView; preview?: boolean; onEnded?: () => void;
  captureRef?: React.MutableRefObject<(() => Promise<string | null>) | null>;
}) {
  const WebView = useSandboxWebView();
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const webViewRef = React.useRef<{ injectJavaScript(script: string): void } | null>(null);
  const pendingCaptures = React.useRef(new Map<number, (image: string | null) => void>());
  const nextCapture = React.useRef(0);
  const streamUrl = new URL(session.url);
  if (session.access) streamUrl.searchParams.set('access', session.access);
  streamUrl.searchParams.set('embedded', '1');
  if (preview) streamUrl.searchParams.set('preview', '1');
  const url = streamUrl.toString();
  React.useEffect(() => {
    if (Platform.OS !== 'web') return;
    const origin = new URL(session.url).origin;
    const handle = (event: MessageEvent) => {
      if (event.origin !== origin || event.data?.id !== session.id) return;
      if (event.data.type === 'computer-ended') onEnded?.();
      if (event.data.type === 'computer-snapshot') {
        const resolve = pendingCaptures.current.get(event.data.requestId);
        if (resolve) { pendingCaptures.current.delete(event.data.requestId); resolve(event.data.image ?? null); }
      }
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [onEnded, session.id, session.url]);
  React.useEffect(() => {
    if (!captureRef || preview) return;
    captureRef.current = () => new Promise((resolve) => {
      const requestId = ++nextCapture.current;
      const finish = (image: string | null) => { clearTimeout(timeout); resolve(image); };
      const timeout = setTimeout(() => { pendingCaptures.current.delete(requestId); resolve(null); }, 2000);
      pendingCaptures.current.set(requestId, finish);
      const request = { type: 'viewer-snapshot-request', id: session.id, requestId };
      if (Platform.OS === 'web') iframeRef.current?.contentWindow?.postMessage(request, new URL(session.url).origin);
      else webViewRef.current?.injectJavaScript(`window.postMessage(${JSON.stringify(request)}, '*'); true;`);
    });
    return () => { captureRef.current = null; for (const resolve of pendingCaptures.current.values()) resolve(null);
      pendingCaptures.current.clear(); };
  }, [captureRef, preview, session.id, session.url]);
  const onStreamMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as { type?: string; id?: string; requestId?: number; image?: string };
      if (message.id !== session.id) return;
      if (message.type === 'computer-ended') onEnded?.();
      if (message.type === 'computer-snapshot' && message.requestId !== undefined) {
        const resolve = pendingCaptures.current.get(message.requestId);
        if (resolve) { pendingCaptures.current.delete(message.requestId); resolve(message.image ?? null); }
      }
    } catch { /* Ignore unrelated page messages. */ }
  };
  if (session.status === 'ended') return <View style={styles.ended} testID="computer-session-ended"><Text style={styles.endedText}>Browser session ended</Text></View>;
  if (!session.access) return <View style={styles.ended}><Text style={styles.endedText}>Connecting to browser…</Text></View>;
  if (Platform.OS === 'web') return React.createElement('iframe', {
    ref: iframeRef,
    src: url,
    title: session.title,
    style: { width: '100%', height: '100%', border: 0, pointerEvents: preview ? 'none' : 'auto' },
    'data-testid': preview ? 'computer-session-preview-frame' : 'computer-session-view-frame',
  });
  if (WebView) return <WebView ref={webViewRef} source={{ uri: url }} javaScriptEnabled domStorageEnabled
    onMessage={onStreamMessage}
    scrollEnabled={false} automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never" style={styles.stream} testID={preview ? 'computer-session-preview-webview' : 'computer-session-view-webview'} />;
  return <View style={styles.ended}><Text style={styles.endedText}>Opening browser…</Text></View>;
}

/** The live card uses a real stream while mounted; it never snapshots or polls. */
export function ComputerSessionCard({ session, isDesktop, agentHandle }: { session: ComputerSessionView; isDesktop?: boolean; agentHandle?: string }) {
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
    // Keep the preview on its existing authorized stream. Replacing its URL
    // tears down the warm connection just as the full viewer needs its frame.
    await openComputerSessionViewer(session, isDesktop, currentViewerConversation()?.roomId, agentHandle);
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

/** A transcript reference gets fresh access through the same authority as a card. */
export async function openComputerSessionViewer(session: ComputerSessionView, isDesktop = false,
  roomId = currentViewerConversation()?.roomId, agentHandle = session.agentHandle) {
  try {
    const access = session.status === 'live'
      ? (await monolithPhoneOperation('openComputerSession', { id: session.id })).access : undefined;
    const permitted = { ...session, access, agentHandle };
    if (isDesktop && openComputerInDesktopWorkPane(permitted)) return access ?? null;
    Modal.show({ component: ComputerSessionViewer,
      props: { session: permitted, agentHandle, roomId }, placement: 'fill' });
    return access ?? null;
  } catch {
    Modal.alert('Could not open browser', 'The live browser is unavailable. Try again.');
    return null;
  }
}

/** Browser controls occupy their own row above the live page. */
export function ComputerSessionViewer({ session, onClose, roomId, agentHandle }: {
  session: ComputerSessionView; onClose: () => void; roomId?: string; agentHandle?: string;
}) {
  const insets = useSafeAreaInsets();
  const captureRef = React.useRef<(() => Promise<string | null>) | null>(null);
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
  return <View style={[styles.viewer, { paddingTop: insets.top + 12, paddingBottom: insets.bottom }]} testID="computer-session-viewer">
    <View style={styles.controls} testID="computer-session-controls">
      {!ended && session.access ? <Pressable style={styles.browserControl} onPress={() => void openInBrowser()} accessibilityRole="button" accessibilityLabel="Open in browser" testID="computer-session-open-browser"><Text style={styles.controlText}>Open ↗</Text></Pressable> : null}
      <Pressable style={styles.control} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close browser" testID="computer-session-close"><Text style={styles.controlText}>✕</Text></Pressable>
    </View>
    <View style={styles.viewerStream}><ComputerStream session={shownSession} onEnded={() => setEnded(true)} captureRef={captureRef} /></View>
    <ViewerConversationDock kind="computer" title={session.title} roomId={roomId}
      agentHandle={agentHandle} captureScreen={() => captureRef.current?.() ?? Promise.resolve(null)} />
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
  viewerStream: { flex: 1, minHeight: 0 },
  controls: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginHorizontal: 12, marginBottom: 12 },
  control: { width: 42, height: 42, borderRadius: 14, borderWidth: 1, borderColor: theme.buzz.borderStrong, backgroundColor: theme.buzz.bgBase, alignItems: 'center', justifyContent: 'center' },
  browserControl: { height: 42, paddingHorizontal: theme.buzz.space.sm, borderRadius: 14, borderWidth: 1, borderColor: theme.buzz.borderStrong, backgroundColor: theme.buzz.bgBase, alignItems: 'center', justifyContent: 'center' },
  controlText: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  ended: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.buzz.bgBase },
  endedText: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
}));
