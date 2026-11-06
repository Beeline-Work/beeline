import { IndexRow } from '@/components/buzz/IndexRow';
import { Button } from './Button';
import { CloseButton } from './CloseGlyph';
import { ContentTarget, InlineRow } from './IndexRow';
import React from 'react';
import { AppState, BackHandler, Platform, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { useSandboxWebView } from '@/components/buzz/sandbox-webview';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Modal } from '@/modal';
import { openComputerInDesktopWorkPane } from '@/buzz/desktop-computer-pane';
import { openExternalUrl } from '@/utils/open-external-url';
import { ViewerConversationDock } from '@/components/buzz/ViewerConversationDock';
import { currentViewerConversation, subscribeViewerConversation } from '@/buzz/viewer-conversation';
import { useArtifactRowVisible } from '@/buzz/artifact-viewport';
import {
  attachWarmComputerHost, closeWarmComputerSession, openWarmComputerSession,
  readWarmComputerSession, subscribeWarmComputerSession, warmComputerSession,
} from '@/buzz/warm-computer-session';

const fullViewers = new Map<string, number>();
const viewerListeners = new Set<() => void>();
const subscribeViewers = (listener: () => void) => {
  viewerListeners.add(listener);
  return () => { viewerListeners.delete(listener); };
};
function retainFullViewer(id: string): () => void {
  fullViewers.set(id, (fullViewers.get(id) ?? 0) + 1);
  for (const listener of viewerListeners) listener();
  return () => {
    const remaining = (fullViewers.get(id) ?? 1) - 1;
    if (remaining) fullViewers.set(id, remaining); else fullViewers.delete(id);
    for (const listener of viewerListeners) listener();
  };
}
const foregroundSnapshot = () => AppState.currentState === 'active';
const subscribeForeground = (listener: () => void) => {
  const subscription = AppState.addEventListener('change', listener);
  return () => subscription.remove();
};
function useComputerForeground(): boolean {
  return React.useSyncExternalStore(subscribeForeground, foregroundSnapshot, () => false);
}
function useViewerRoomFocused(roomId: string | undefined): boolean {
  return React.useSyncExternalStore(subscribeViewerConversation,
    () => roomId ? Boolean(currentViewerConversation(roomId)) : true, () => false);
}

export type ComputerSessionView = NonNullable<RoomViewMessage['computerSession']> & {
  access?: string; agentHandle?: string;
  /** In-memory capture from the mounted preview; never part of the Room DTO. */
  previewFrame?: Promise<string | null>;
};

function ComputerStream({ session, preview = false, onEnded, onFirstFrame, onAccessRejected, captureRef, warm = false, interactive = true }: {
  session: ComputerSessionView; preview?: boolean; onEnded?: () => void; onFirstFrame?: () => void;
  onAccessRejected?: () => void; warm?: boolean; interactive?: boolean;
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
  if (warm) streamUrl.searchParams.set('warm', '1');
  const url = streamUrl.toString();
  React.useEffect(() => {
    if (Platform.OS !== 'web') return;
    const origin = new URL(session.url).origin;
    const handle = (event: MessageEvent) => {
      if (event.origin !== origin || event.data?.id !== session.id) return;
      if (event.data.type === 'computer-ended') onEnded?.();
      if (event.data.type === 'computer-first-frame') onFirstFrame?.();
      if (event.data.type === 'computer-snapshot') {
        const resolve = pendingCaptures.current.get(event.data.requestId);
        if (resolve) { pendingCaptures.current.delete(event.data.requestId); resolve(event.data.image ?? null); }
      }
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [onEnded, onFirstFrame, session.id, session.url]);
  React.useEffect(() => {
    if (!captureRef) return;
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
  const setViewerMode = React.useCallback(() => {
    if (!warm) return;
    const mode = { type: 'viewer-mode', id: session.id, interactive };
    webViewRef.current?.injectJavaScript(`window.postMessage(${JSON.stringify(mode)}, '*'); true;`);
  }, [warm, session.id, interactive]);
  React.useEffect(setViewerMode, [setViewerMode]);
  const onStreamMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as { type?: string; id?: string; requestId?: number; image?: string; text?: string };
      if (message.id !== session.id) return;
      // The viewer's paste button and copied page text use this device's clipboard.
      if (message.type === 'computer-paste-request') void Clipboard.getStringAsync().then((text) => {
        const paste = { type: 'viewer-paste', id: session.id, text };
        webViewRef.current?.injectJavaScript(`window.postMessage(${JSON.stringify(paste)}, '*'); true;`);
      }).catch(() => {});
      if (message.type === 'computer-copy' && typeof message.text === 'string') void Clipboard.setStringAsync(message.text).catch(() => {});
      if (message.type === 'computer-ended') onEnded?.();
      if (message.type === 'computer-first-frame') onFirstFrame?.();
      if (message.type === 'computer-snapshot' && message.requestId !== undefined) {
        const resolve = pendingCaptures.current.get(message.requestId);
        if (resolve) { pendingCaptures.current.delete(message.requestId); resolve(message.image ?? null); }
      }
    } catch { /* Ignore unrelated page messages. */ }
  };
  if (session.status === 'ended')
    return (
      <View style={styles.ended} testID="computer-session-ended"><Text style={styles.endedText}>Browser session ended</Text></View>
    );
  if (!session.access)
    return (
      <View style={styles.ended}><Text style={styles.endedText}>Connecting to browser…</Text></View>
    );
  if (Platform.OS === 'web') return React.createElement('iframe', {
    ref: iframeRef,
    src: url,
    title: session.title,
    // The viewer is cross-origin; paste and copy need the clipboard delegated.
    allow: 'clipboard-read; clipboard-write',
    style: { width: '100%', height: '100%', border: 0, pointerEvents: preview ? 'none' : 'auto' },
    'data-testid': preview ? 'computer-session-preview-frame' : 'computer-session-view-frame',
  });
  if (WebView)
    return (
      <WebView ref={webViewRef} source={{ uri: url }} javaScriptEnabled domStorageEnabled
    onMessage={onStreamMessage} onLoadEnd={setViewerMode}
    onHttpError={(event: { nativeEvent: { statusCode: number } }) => {
      if (event.nativeEvent.statusCode === 401 || event.nativeEvent.statusCode === 403) onAccessRejected?.();
      if (event.nativeEvent.statusCode === 410) onEnded?.();
    }}
    scrollEnabled={false} setBuiltInZoomControls={false} setDisplayZoomControls={false}
    automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never" style={styles.stream} testID={preview ? 'computer-session-preview-webview' : 'computer-session-view-webview'} />
    );
  return (
    <View style={styles.ended}><Text style={styles.endedText}>Opening browser…</Text></View>
  );
}

/** Only actual visible rows stream; opening captures the latest frame once. */
export function ComputerSessionCard({ session, messageId, roomId, isDesktop, agentHandle }: { session: ComputerSessionView; messageId: string; roomId: string; isDesktop?: boolean; agentHandle?: string }) {
  const rowVisible = useArtifactRowVisible(messageId, true);
  const foreground = useComputerForeground();
  const visible = rowVisible && foreground;
  const fullViewer = React.useSyncExternalStore(subscribeViewers,
    () => fullViewers.has(session.id) || (Platform.OS !== 'web' && fullViewers.size > 0), () => false);
  const [authorized, setAuthorized] = React.useState({ id: session.id, access: session.access ?? null });
  const access = session.access ?? (authorized.id === session.id ? authorized.access : null);
  const owner = React.useRef({ id: session.id, mounted: true });
  owner.current.id = session.id;
  React.useEffect(() => {
    owner.current.mounted = true;
    return () => { owner.current.mounted = false; };
  }, []);
  const captureRef = React.useRef<(() => Promise<string | null>) | null>(null);
  const requested = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (!visible || session.status !== 'live' || session.access || requested.current === session.id) return;
    requested.current = session.id;
    void monolithPhoneOperation('openComputerSession', { id: session.id })
      .then(({ access: token }) => {
        if (owner.current.mounted && owner.current.id === session.id) setAuthorized({ id: session.id, access: token });
      })
      .catch(() => {
        if (owner.current.mounted && owner.current.id === session.id) setAuthorized({ id: session.id, access: null });
      });
  }, [session.id, session.status, session.access, visible]);
  React.useEffect(() => {
    if (!visible || Platform.OS === 'web' || !access || session.status !== 'live') return;
    return warmComputerSession({ ...session, access }, roomId, agentHandle);
  }, [session.id, session.url, session.title, session.status, access, agentHandle, visible, roomId]);
  const open = async () => {
    if (!visible || !access || session.status !== 'live') return;
    // Keep the preview on its existing authorized stream. Replacing its URL
    // tears down the warm connection just as the full viewer needs its frame.
    await openComputerSessionViewer({ ...session, access,
      previewFrame: captureRef.current?.() }, isDesktop, roomId, agentHandle);
  };
  const openInBrowser = async () => {
    if (!visible || !access || session.status !== 'live') return;
    try {
      const { access: freshAccess } = await monolithPhoneOperation('openComputerSession', { id: session.id });
      const url = new URL(session.url);
      url.searchParams.set('access', freshAccess);
      await openExternalUrl(url.toString());
    } catch {
      Modal.alert('Could not open browser', 'The live browser is unavailable. Try again.');
    }
  };
  return (
    <View style={styles.card} testID={`computer-session-card-${session.status}`}>
      {session.status === 'live' && access ? (
        <ContentTarget onPress={() => void open()} accessibilityRole="button" accessibilityLabel={`Open ${session.title} browser`}>
      <View style={styles.preview} pointerEvents="none">{visible && !fullViewer ? <ComputerStream session={{ ...session, access }} preview captureRef={captureRef} /> : null}</View>
      <View style={styles.caption}><Text numberOfLines={1} style={styles.title}>{session.title}</Text>
        <Text style={styles.kind}>Live browser</Text></View>
    </ContentTarget>
      ) : (
        <View style={styles.caption}><Text numberOfLines={1} style={styles.title}>{session.title}</Text>
      <Text style={styles.kind}>{session.status === 'ended' ? 'Session ended' : 'Live browser'}</Text></View>
      )}
      {session.status === 'live' && access ? (
        <InlineRow style={styles.footer}>
          <Button label="Open in browser" destination="external" variant="quiet"
            appearance={{ control: undefined, label: styles.footerQuiet }}
            accessibilityRole="link" accessibilityLabel="Open in browser"
            testID="computer-session-card-open-browser" onPress={() => void openInBrowser()} />
          <View style={styles.footerSpacer} />
          <Button label="Open" destination="screen" variant="quiet"
            appearance={{ control: undefined, label: styles.footerPrimary }}
            accessibilityRole="link" accessibilityLabel="Open live browser"
            testID="computer-session-open" onPress={() => void open()} />
        </InlineRow>
      ) : null}
    </View>
  );
}

/** Warm cards open immediately; references without access obtain it first. */
export async function openComputerSessionViewer(
  session: ComputerSessionView,
  isDesktop = false,
  roomId = currentViewerConversation()?.roomId,
  agentHandle = session.agentHandle,
) {
  try {
    const access =
      session.status === 'live'
        ? (session.access
      ?? (await monolithPhoneOperation('openComputerSession', { id: session.id })).access)
        : undefined;
    const permitted = { ...session, access, agentHandle };
    if (isDesktop && openComputerInDesktopWorkPane(permitted)) return access ?? null;
    if (Platform.OS !== 'web' && openWarmComputerSession(permitted, roomId, agentHandle)) return access ?? null;
    Modal.show({ component: ComputerSessionViewer,
      props: { session: permitted, agentHandle, roomId }, placement: 'fill' });
    return access ?? null;
  } catch {
    Modal.alert('Could not open browser', 'The live browser is unavailable. Try again.');
    return null;
  }
}

/** Retain the selected session locally; only an opened viewer mounts a stream. */
export function WarmComputerSessionHost() {
  const warm = React.useSyncExternalStore(subscribeWarmComputerSession, readWarmComputerSession, () => null);
  const focused = useViewerRoomFocused(warm?.roomId);
  React.useEffect(() => (Platform.OS === 'web' ? undefined : attachWarmComputerHost()), []);
  React.useEffect(() => {
    if (!warm?.visible || !focused || Platform.OS === 'web') return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      closeWarmComputerSession(); return true;
    });
    return () => back.remove();
  }, [warm?.visible, focused]);
  if (Platform.OS === 'web' || !warm?.visible) return null;
  return (
    <View style={[styles.warmHost, { opacity: focused ? 1 : 0 }]}
    pointerEvents={focused ? 'auto' : 'none'}
    accessibilityViewIsModal={focused} accessibilityElementsHidden={!focused}
    importantForAccessibility={focused ? 'auto' : 'no-hide-descendants'}
    testID="computer-session-warm-host">
    <ComputerSessionViewer key={warm.session.id} session={warm.session} active={focused} warm
      roomId={warm.roomId} agentHandle={warm.agentHandle} onClose={closeWarmComputerSession} />
  </View>
  );
}

/** Browser controls occupy their own row above the live page. */
export function ComputerSessionViewer({ session, onClose, roomId, agentHandle, active = true, warm = false }: {
  session: ComputerSessionView; onClose: () => void; roomId?: string; agentHandle?: string; active?: boolean; warm?: boolean;
}) {
  const foreground = useComputerForeground();
  const focused = useViewerRoomFocused(roomId);
  const displayed = active && focused && foreground;
  React.useLayoutEffect(() => displayed ? retainFullViewer(session.id) : undefined, [displayed, session.id]);
  const insets = useSafeAreaInsets();
  const captureRef = React.useRef<(() => Promise<string | null>) | null>(null);
  const [ended, setEnded] = React.useState(session.status === 'ended');
  const [unavailable, setUnavailable] = React.useState(false);
  const [refreshedAccess, setRefreshedAccess] = React.useState<string>();
  const [accessRejected, setAccessRejected] = React.useState(() =>
    Number(session.access?.split('.')[1]) <= Date.now());
  const [previewFrame, setPreviewFrame] = React.useState<string | null>(null);
  const firstFrame = React.useRef(false);
  const requested = React.useRef<string | undefined>(undefined);
  const requestKey = `${session.id}:${session.access ?? ''}`;
  const owner = React.useRef({ key: requestKey, mounted: true });
  owner.current.key = requestKey;
  React.useEffect(() => {
    owner.current.mounted = true;
    return () => { owner.current.mounted = false; };
  }, []);
  React.useEffect(() => {
    const key = `${session.id}:${session.access ?? ''}`;
    if (!displayed || session.status !== 'live' || !session.access || requested.current === key) return;
    requested.current = key;
    // The stream still checks current Room membership and token validity.
    // Refresh without replacing its URL and restarting a warm connection.
    void monolithPhoneOperation('openComputerSession', { id: session.id })
      .then(({ access }) => { if (owner.current.mounted && owner.current.key === key) setRefreshedAccess(access); })
      .catch((error: unknown) => {
        if (owner.current.mounted && owner.current.key === key && error instanceof Error && 'status' in error
          && (error.status === 401 || error.status === 403 || error.status === 404)) setUnavailable(true);
      });
  }, [session.id, session.status, session.access, displayed]);
  React.useEffect(() => {
    let mounted = true;
    void session.previewFrame?.then(image => {
      if (mounted && !firstFrame.current) setPreviewFrame(image);
    }).catch(() => {});
    return () => { mounted = false; };
  }, [session.previewFrame]);
  React.useEffect(() => { if (session.status === 'ended') setEnded(true); }, [session.status]);
  const shownSession = { ...session, ...(ended ? { status: 'ended' as const } : {}),
    access: accessRejected && refreshedAccess ? refreshedAccess : session.access };
  const openInBrowser = async () => {
    if (!displayed || ended || !session.access) return;
    try {
      const { access } = await monolithPhoneOperation('openComputerSession', { id: session.id });
      const url = new URL(session.url);
      url.searchParams.set('access', access);
      await openExternalUrl(url.toString());
    } catch {
      Modal.alert('Could not open browser', 'The live browser is unavailable. Try again.');
    }
  };
  return (
    <View style={[styles.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom }]} testID="computer-session-viewer">
      <InlineRow style={styles.controls} testID="computer-session-controls">
        {!ended && !unavailable && session.access ? (
          <Button
            label="Open in browser"
            destination="external"
            size="inline"
            style={styles.openBrowser}
            accessibilityRole="link"
            variant="secondary"
            onPress={() => void openInBrowser()}
            accessibilityLabel="Open in browser"
            testID="computer-session-open-browser"
          />
        ) : null}
        <CloseButton
          onPress={onClose}
          accessibilityLabel="Close browser"
          testID="computer-session-close"
        />
      </InlineRow>
      <View style={styles.viewerStream}>
        {unavailable ? (
          <View style={styles.failureInset} >
            <IndexRow inset="flush" title="Browser unavailable" description={"Browser is unavailable"} />
          </View>
        ) : displayed ? (
          <ComputerStream session={shownSession} warm={warm} interactive={active} onEnded={() => setEnded(true)}
          onFirstFrame={() => { firstFrame.current = true; setPreviewFrame(null); }}
          onAccessRejected={() => {
            if (accessRejected && refreshedAccess) setUnavailable(true);
            else setAccessRejected(true);
          }} captureRef={captureRef} />
        ) : null}
        {!ended && !unavailable && previewFrame ? (
          <View pointerEvents="none" style={styles.previewFrame}>
        <Image source={{ uri: `data:image/jpeg;base64,${previewFrame}` }} contentFit="cover" contentPosition="top"
          style={styles.stream} testID="computer-session-opening-frame" />
      </View>
        ) : null}
      </View>
      {displayed ? (
        <ViewerConversationDock keyboardAvoidedByParent={!warm} kind="computer" title={session.title} roomId={roomId}
      agentHandle={agentHandle} captureScreen={() => captureRef.current?.() ?? Promise.resolve(null)} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  failureInset: { paddingHorizontal: theme.buzz.roomList.edge },
  warmHost: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
  card: { width: '100%', marginTop: theme.buzz.transcriptCard.marginTop, borderWidth: 1, borderColor: theme.buzz.borderStrong, borderRadius: theme.buzz.transcriptCard.cornerRadius, overflow: 'hidden' },
  preview: { height: 218, backgroundColor: theme.buzz.bgBase },
  stream: { width: '100%', height: '100%', backgroundColor: theme.buzz.bgBase },
  caption: { paddingHorizontal: theme.buzz.transcriptCard.side, paddingVertical: theme.buzz.space.sm, gap: theme.buzz.space.xs },
  title: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  kind: { ...theme.buzz.type.machine, color: theme.buzz.ledgerQuiet },
  footerSpacer: { flex: 1 },
  footerQuiet: { ...theme.buzz.type.body, color: theme.buzz.ledgerQuiet },
  footerPrimary: { ...theme.buzz.type.body, color: theme.buzz.accent },
  footer: { paddingVertical: theme.buzz.transcriptCard.footerVertical, minHeight: theme.buzz.transcriptCard.footerMinHeight, paddingHorizontal: theme.buzz.transcriptCard.side, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: theme.buzz.border },
  viewer: { flex: 1, backgroundColor: theme.buzz.bgBase },
  viewerStream: { flex: 1, minHeight: 0 },
  previewFrame: { position: 'absolute', inset: 0, width: '100%', height: '100%' },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: theme.buzz.space.sm,
    marginTop: theme.buzz.space.md, marginHorizontal: theme.buzz.space.md, marginBottom: theme.buzz.space.sm },
  openBrowser: { alignSelf: 'center' },
  control: {
    width: 44,
    height: 44,
    borderRadius: theme.buzz.radius,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    backgroundColor: theme.buzz.bgBase,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ended: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.buzz.bgBase },
  endedText: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
}));
