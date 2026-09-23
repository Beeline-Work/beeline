import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AttachmentReference } from '@beeline/buzz-client';

import { artifactFormat, createInitialLoadGuard, wrapArtifactMarkup } from '@/buzz/artifact';
import { artifactPdfLocalUri, fetchArtifactBytes, fetchArtifactText } from '@/buzz/artifact-link';
import { artifactWebViewProps } from '@/components/buzz/artifact-webview';
import { useSandboxWebView, useSandboxWebViewStatus } from '@/components/buzz/sandbox-webview';
import { ArtifactText } from '@/components/buzz/ArtifactMedia';
import { ZoomableArtifactImage } from '@/components/buzz/ZoomableArtifactImage';
import { ArtifactPdfView } from '@/components/buzz/ArtifactPdfView';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { CodeHighlighter } from '@/components/buzz/CodeHighlighter';
import type { CodeDocument } from '@/buzz/code-document';
import * as Clipboard from 'expo-clipboard';
import { copyPicture, sharePicture } from '@/buzz/picture-actions';
import { useCopiedToast } from '@/components/buzz/CopiedToast';

/**
 * The full-screen artifact viewer (mock 1c): the whole page, still guarded —
 * exactly one navigation passes the gate, everything after it is refused, and
 * nothing here ever receives an onMessage bridge. Markdown renders through the
 * app's own renderer and plain text through the mono reader; an image fits the
 * screen; a PDF rides a local cache file on iOS and the fitted pdf.js document
 * on Android. Script stays off for everything except that document, which is
 * the renderer itself rather than anything an artifact's author wrote.
 */
export function ArtifactViewerScreen({
  attachment,
  document,
  notice,
  onClose,
}: (
  | { attachment: AttachmentReference; document?: never; notice?: never }
  | { attachment?: never; document: CodeDocument; notice?: never }
  | { attachment?: never; document?: never; notice: { title: string; message: string } }
) & { authorHandle?: string; onClose: () => void }) {
  const format = attachment ? artifactFormat(attachment.mimeType) : document ? 'code' : 'notice';
  const title = attachment
    ? (attachment.title ?? attachment.name)
    : document
      ? document.title
      : notice.title;
  // The viewer fills the whole screen (HullModal placement 'fill', which is
  // translucent under both system bars on Android's mandatory edge-to-edge),
  // so the header row — title and the ✕ that closes the viewer — must clear
  // the status tray the way every full-screen surface does.
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { showCopied, toast } = useCopiedToast('artifact-viewer-copied');
  return (
    <View style={styles.screen} testID="artifact-viewer">
      <View style={[styles.header, { paddingTop: insets.top + theme.buzz.space.md }]}>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {title}
        </Text>
        {format === 'code' && document ? (
          <Pressable
            accessibilityLabel="Copy code"
            accessibilityRole="button"
            onPress={() =>
              void Clipboard.setStringAsync(document.code).then((copied) => {
                if (copied) showCopied('Code copied to clipboard');
              })
            }
            style={styles.headerAction}
            testID="artifact-viewer-copy"
          >
            <Text style={styles.headerActionText}>Copy</Text>
          </Pressable>
        ) : format === 'image' ? (
          <>
            <Pressable
              accessibilityLabel="Copy image"
              accessibilityRole="button"
              onPress={() =>
                void copyPicture(attachment!).then((copied) => {
                  if (copied) showCopied('Image copied to clipboard');
                })
              }
              style={styles.headerAction}
              testID="artifact-viewer-copy"
            >
              <Text style={styles.headerActionText}>Copy</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Share image"
              accessibilityRole="button"
              onPress={() => void sharePicture(attachment!)}
              style={styles.headerAction}
              testID="artifact-viewer-share"
            >
              <Text style={styles.headerActionText}>Share</Text>
            </Pressable>
          </>
        ) : null}
        <Pressable
          accessibilityLabel="Close artifact viewer"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.headerAction}
          testID="artifact-viewer-close"
        >
          <Text style={styles.headerClose}>✕</Text>
        </Pressable>
      </View>
      <View style={styles.body}>
        {format === 'code' && document ? (
          <ScrollView contentContainerStyle={styles.codeBody} testID="artifact-viewer-code">
            <Text style={styles.codeInscription}>{document.inscription}</Text>
            <CodeHighlighter code={document.code} language={document.language} />
          </ScrollView>
        ) : format === 'notice' ? (
          <View style={styles.placeholder} testID="artifact-viewer-notice">
            <Text style={styles.placeholderText}>{notice!.message}</Text>
          </View>
        ) : format === 'markdown' ? (
          <ArtifactViewerMarkdown attachment={attachment!} />
        ) : format === 'image' ? (
          <ZoomableArtifactImage attachment={attachment!} title={title} />
        ) : format === 'text' ? (
          <ArtifactText attachment={attachment!} crop={false} testID="artifact-viewer-text" />
        ) : format === 'pdf' && Platform.OS !== 'ios' ? (
          <ArtifactPdfView attachment={attachment!} mode="viewer" testID="artifact-viewer-pdf" />
        ) : (
          <ArtifactViewerSandbox
            attachment={attachment!}
            format={format as 'html' | 'svg' | 'pdf' | 'document'}
          />
        )}
      </View>
      {toast}
    </View>
  );
}

/** HTML/SVG/PDF-iOS: the sandboxed render of the full page. */
export function ArtifactViewerSandbox({
  attachment,
  format,
}: {
  attachment: AttachmentReference;
  format: 'html' | 'svg' | 'pdf' | 'document';
}) {
  const [source, setSource] = useState<{ html: string } | { uri: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const guardRef = useRef(createInitialLoadGuard());
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if (format === 'pdf') {
          const uri = await artifactPdfLocalUri(attachment);
          if (live) setSource({ uri });
          return;
        }
        if (format === 'html' || format === 'svg') {
          const bytes = await fetchArtifactBytes(attachment);
          if (live)
            setSource({ html: wrapArtifactMarkup(new TextDecoder().decode(bytes), format) });
          return;
        }
        if (live) setFailed('This file type has no inline preview — open it in a browser instead.');
      } catch {
        if (live) setFailed('The page could not be loaded. Try again.');
      }
    })();
    return () => {
      live = false;
    };
  }, [attachment, format]);
  const WebView = useSandboxWebView();
  const webviewStatus = useSandboxWebViewStatus();
  useEffect(() => {
    // The renderer never became available (the dynamic import failed): the
    // honest state is spoken, not an eternal "Loading…".
    if (source && !WebView && webviewStatus === 'unavailable') {
      setFailed('The in-app page renderer is unavailable — open it in a browser instead.');
    }
  }, [source, WebView, webviewStatus]);
  if (failed) {
    return (
      <View style={styles.placeholder} testID="artifact-viewer-failed">
        <Text style={styles.placeholderText}>{failed}</Text>
      </View>
    );
  }
  if (source && WebView) {
    return (
      <WebView
        {...artifactWebViewProps({ source, guard: guardRef.current, scrollEnabled: true })}
        style={styles.webview}
        testID="artifact-viewer-webview"
      />
    );
  }
  return (
    <View style={styles.placeholder} testID="artifact-viewer-loading">
      <Text style={styles.placeholderText}>Loading…</Text>
    </View>
  );
}

function ArtifactViewerMarkdown({ attachment }: { attachment: AttachmentReference }) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void fetchArtifactText(attachment)
      .then((text) => {
        if (live) setMarkdown(text);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [attachment]);
  if (failed) {
    return (
      <View style={styles.placeholder} testID="artifact-viewer-failed">
        <Text style={styles.placeholderText}>The page could not be loaded. Try again.</Text>
      </View>
    );
  }
  if (markdown == null) {
    return (
      <View style={styles.placeholder} testID="artifact-viewer-loading">
        <Text style={styles.placeholderText}>Loading…</Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.markdownBody} testID="artifact-viewer-markdown">
      <MonoMarkdown markdown={markdown} textStyle={styles.markdownText} />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.space.md,
    // The top clearance over the status tray is supplied by the screen
    // (insets.top + space.md); the sheet never carries a second one.
    paddingBottom: theme.buzz.space.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.buzz.border,
  },
  headerTitle: {
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
    flex: 1,
    minWidth: 0,
  },
  headerClose: { ...theme.buzz.type.body, color: theme.buzz.ledgerQuiet },
  headerAction: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerActionText: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  body: { flex: 1 },
  webview: { flex: 1, backgroundColor: 'transparent' },
  codeBody: { flexGrow: 1, padding: theme.buzz.space.md },
  codeInscription: {
    ...theme.buzz.type.machine,
    color: theme.buzz.ledgerBody,
    marginBottom: theme.buzz.space.md,
  },
  markdownBody: { padding: theme.buzz.space.md },
  markdownText: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  placeholderText: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
}));
