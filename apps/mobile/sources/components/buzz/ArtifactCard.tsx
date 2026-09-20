import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AttachmentReference } from '@beeline/buzz-client';

import {
  ARTIFACT_MAX_PREVIEW_HEIGHT,
  artifactCapabilities,
  artifactFormat,
  createInitialLoadGuard,
  mediaIdFromUrl,
  wrapArtifactMarkup,
} from '@/buzz/artifact';
import {
  artifactPreviewCachePath,
  probeArtifactPreview,
  snapshotArtifactPreview,
} from '@/buzz/artifact-preview-cache';
import {
  artifactPdfLocalUri,
  fetchArtifactBytes,
  fetchArtifactText,
  openArtifactInBrowserOrExplain,
} from '@/buzz/artifact-link';
import { formatAttachmentSize } from '@/buzz/chat-attachment';
import { openArtifactInDesktopWorkPane } from '@/buzz/desktop-artifact-pane';
import { artifactWebViewProps } from '@/components/buzz/artifact-webview';
import { useSandboxWebView } from '@/components/buzz/sandbox-webview';
import { ArtifactViewerScreen } from '@/components/buzz/ArtifactViewer';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { Modal } from '@/modal';

const PREVIEW_SNAPSHOT_DELAY_MS = 1200;

/**
 * The artifact card IS the preview (mock 1b): the page itself rendered on the
 * device, cropped to a fixed height, script off, non-interactive, rendered
 * once when the card mounts into the transcript window and snapshotted to an
 * image cached on the device keyed by object id. Every later mount shows the
 * cached image — no second render on scroll. Title as caption with author and
 * size; footer `Open in browser` and `Open`; no status label — if it is in
 * front of you it is ready. The existing expired treatment (the plain
 * attachment card) covers the page-is-gone case upstream, so this component
 * only ever renders a live artifact.
 */
export const ArtifactCard = React.memo(function ArtifactCard({
  attachment,
  authorHandle,
  isDesktop = false,
}: {
  attachment: AttachmentReference;
  authorHandle?: string;
  isDesktop?: boolean;
}) {
  const format = artifactFormat(attachment.mimeType);
  const capabilities = artifactCapabilities(
    attachment.mimeType,
    isDesktop ? 'desktop' : Platform.OS === 'ios' ? 'ios' : 'android',
  );
  const title = attachment.title ?? attachment.name;
  const kindWord = format === 'document' ? attachment.mimeType.toLowerCase() : format;
  const kindLine = `${authorHandle ? `@${authorHandle.replace(/^@/, '')} · ` : ''}${kindWord} · ${formatAttachmentSize(attachment.size)}`;
  const openInBrowser = useCallback(
    () => void openArtifactInBrowserOrExplain(attachment),
    [attachment],
  );
  const openFull = useCallback(() => {
    if (isDesktop) {
      openArtifactInDesktopWorkPane({ attachment, authorHandle });
      return;
    }
    Modal.show({
      component: ArtifactViewerScreen,
      props: { attachment, authorHandle },
      // The viewer is a full-screen surface: the default centered placement
      // constrains width to 460 and no height, collapsing its flex:1 root to
      // nothing — a dimmed room with an invisible viewer.
      placement: 'fill',
    });
  }, [attachment, authorHandle, isDesktop]);

  // Android hands the whole PDF to the system viewer (phase one); desktop
  // previews and opens through the browser. iOS renders the first page here.
  // Raster images keep the file-style card but open in the native phone viewer.
  if (capabilities.preview === 'external') {
    const actions =
      capabilities.viewer === 'external' && (format !== 'pdf' || isDesktop)
        ? (['browser'] as const)
        : (['browser', 'open'] as const);
    return (
      <ArtifactCardShell
        title={title}
        kindLine={kindLine}
        actions={actions}
        onOpenInBrowser={openInBrowser}
        onOpenFull={openFull}
        testID={`artifact-document-${attachment.name}`}
      >
        <View style={styles.docRow} testID="artifact-document-body">
          <Text style={styles.docGlyph}>▧</Text>
          <Text numberOfLines={1} style={styles.docName}>
            {attachment.name} · {formatAttachmentSize(attachment.size)}
          </Text>
        </View>
      </ArtifactCardShell>
    );
  }
  return (
    <ArtifactCardShell
      title={title}
      kindLine={kindLine}
      actions={['browser', 'open']}
      onOpenInBrowser={openInBrowser}
      onOpenFull={openFull}
      testID={`artifact-${format}-${attachment.name}`}
    >
      <Pressable
        accessibilityLabel={`Open ${title} full screen`}
        accessibilityRole="button"
        onPress={openFull}
        style={styles.previewPress}
        testID={`artifact-preview-${attachment.name}`}
      >
        {format === 'markdown' ? (
          <ArtifactMarkdownPreview attachment={attachment} />
        ) : (
          <ArtifactSandboxPreview
            attachment={attachment}
            format={format === 'pdf' ? 'pdf' : format === 'svg' ? 'svg' : 'html'}
          />
        )}
      </Pressable>
    </ArtifactCardShell>
  );
});

/** Shared shell: preview body, caption, footer — the mock 1b grammar. */
function ArtifactCardShell({
  title,
  kindLine,
  actions,
  onOpenInBrowser,
  onOpenFull,
  children,
  testID,
}: {
  title: string;
  kindLine: string;
  actions: readonly ('browser' | 'open')[];
  onOpenInBrowser(): void;
  onOpenFull(): void;
  children: React.ReactNode;
  testID: string;
}) {
  return (
    <View style={styles.card} testID={testID}>
      {children}
      <View style={styles.caption}>
        <Text numberOfLines={1} style={styles.captionTitle} testID="artifact-title">
          {title}
        </Text>
        <Text numberOfLines={1} style={styles.captionKind} testID="artifact-kind-line">
          {kindLine}
        </Text>
      </View>
      <View style={styles.footer}>
        {actions.includes('browser') ? (
          <Pressable
            accessibilityLabel="Open in browser"
            accessibilityRole="link"
            onPress={onOpenInBrowser}
            testID="artifact-open-browser"
          >
            <Text style={styles.footerQuiet}>Open in browser ↗</Text>
          </Pressable>
        ) : null}
        <View style={styles.footerSpacer} />
        {actions.includes('open') ? (
          <Pressable
            accessibilityLabel="Open artifact"
            accessibilityRole="link"
            onPress={onOpenFull}
            testID="artifact-open"
          >
            <Text style={styles.footerPrimary}>Open →</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

type SandboxPreviewFormat = 'html' | 'svg' | 'pdf';

/**
 * The on-device render of the page itself in the script-off sandbox: rendered
 * once, snapshotted to the device cache keyed by object id. HTML/SVG ride the
 * wrapped markup source; an iOS PDF rides a cache file URI (page one).
 */
export function ArtifactSandboxPreview({
  attachment,
  format,
}: {
  attachment: AttachmentReference;
  format: SandboxPreviewFormat;
}) {
  const viewRef = useRef<View>(null);
  const [snapshotPath, setSnapshotPath] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [documentHtml, setDocumentHtml] = useState<string | null>(null);
  const [pdfUri, setPdfUri] = useState<string | null>(null);
  const guardRef = useRef(createInitialLoadGuard());
  useEffect(() => {
    let live = true;
    void (async () => {
      const cached = await probeArtifactPreview(attachment.url);
      if (!live) return;
      if (cached) {
        setSnapshotPath(cached);
        return;
      }
      try {
        if (format === 'pdf') {
          setPdfUri(await artifactPdfLocalUri(attachment));
        } else {
          const bytes = await fetchArtifactBytes(attachment);
          setDocumentHtml(wrapArtifactMarkup(new TextDecoder().decode(bytes), format));
        }
        if (live) setRendering(true);
      } catch {
        if (live) setRendering(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [attachment, format]);
  const capture = useCallback(async () => {
    const path = await snapshotArtifactPreview(attachment.url, viewRef);
    if (path) {
      setSnapshotPath(path);
      setRendering(false);
    }
  }, [attachment.url]);
  // A page whose load-end never fires still captures once, late; the in-flight
  // marker in the cache module keeps the timer and onLoadEnd from doubling.
  useEffect(() => {
    if (!rendering) return;
    const timer = setTimeout(() => void capture(), PREVIEW_SNAPSHOT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [capture, rendering]);
  const WebView = useSandboxWebView();
  if (snapshotPath) {
    return (
      <View style={styles.preview} testID="artifact-preview-snapshot">
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="cover"
          source={{ uri: snapshotPath }}
          style={styles.previewImage}
        />
        <View style={styles.previewFade} />
      </View>
    );
  }
  if (rendering && WebView) {
    const source = pdfUri
      ? { uri: pdfUri }
      : documentHtml
        ? { html: documentHtml }
        : null;
    if (source) {
      return (
        <View
          ref={viewRef}
          collapsable={false}
          style={styles.preview}
          testID="artifact-preview-render"
        >
          <WebView
            {...artifactWebViewProps({ source, guard: guardRef.current })}
            onLoadEnd={() => void capture()}
            pointerEvents="none"
            style={styles.previewWeb}
          />
          <View style={styles.previewFade} pointerEvents="none" />
        </View>
      );
    }
  }
  return (
    <View style={styles.previewPlaceholder} testID="artifact-preview-loading">
      <Text style={styles.docGlyph}>▧</Text>
    </View>
  );
}

/** Markdown renders through the app's own message renderer, cropped to the card. */
export function ArtifactMarkdownPreview({ attachment }: { attachment: AttachmentReference }) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void fetchArtifactText(attachment)
      .then((text) => {
        if (live) setMarkdown(text);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [attachment]);
  if (markdown == null) {
    return (
      <View style={styles.previewPlaceholder} testID="artifact-preview-loading">
        <Text style={styles.docGlyph}>▧</Text>
      </View>
    );
  }
  return (
    <View pointerEvents="none" style={[styles.preview, styles.markdownCrop]} testID="artifact-preview-markdown">
      <MonoMarkdown markdown={markdown} textStyle={styles.markdownText} />
      <View style={styles.previewFade} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    minWidth: 0,
    width: '100%',
    marginTop: 8,
    borderWidth: 1,
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.transcriptCard.cornerRadius,
    backgroundColor: theme.buzz.bgBase,
    overflow: 'hidden',
  },
  previewPress: { minWidth: 0 },
  preview: {
    height: ARTIFACT_MAX_PREVIEW_HEIGHT,
    backgroundColor: theme.buzz.bgHighlight,
  },
  previewImage: { width: '100%', height: '100%' },
  previewWeb: { width: '100%', height: '100%', backgroundColor: 'transparent' },
  previewFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 44,
    backgroundColor: `${theme.buzz.bgBase}CC`,
  },
  markdownCrop: { overflow: 'hidden', padding: theme.buzz.space.sm },
  markdownText: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  previewPlaceholder: {
    height: ARTIFACT_MAX_PREVIEW_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.buzz.bgHighlight,
  },
  docRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: theme.buzz.space.sm,
  },
  docGlyph: { ...theme.buzz.type.body, color: theme.buzz.steel },
  docName: {
    ...theme.buzz.type.body,
    color: theme.buzz.textPrimary,
    flex: 1,
    minWidth: 0,
  },
  caption: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.space.sm,
    paddingTop: theme.buzz.space.sm,
  },
  captionTitle: {
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
    flexShrink: 1,
  },
  captionKind: { ...theme.buzz.type.machine, color: theme.buzz.ledgerQuiet },
  footer: {
    minHeight: theme.buzz.transcriptCard.footerMinHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.buzz.transcriptCard.side,
    paddingVertical: theme.buzz.transcriptCard.footerVertical,
    borderTopWidth: 1,
    borderTopColor: theme.buzz.border,
  },
  footerSpacer: { flex: 1 },
  footerQuiet: { ...theme.buzz.type.body, color: theme.buzz.ledgerQuiet },
  footerPrimary: { ...theme.buzz.type.body, color: theme.buzz.accent },
}));

// Referenced by tests and the cache module's key derivation.
export { artifactPreviewCachePath, mediaIdFromUrl };
