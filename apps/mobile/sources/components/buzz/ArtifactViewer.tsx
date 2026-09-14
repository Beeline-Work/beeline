import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AttachmentReference } from '@beeline/buzz-client';

import { artifactFormat, createInitialLoadGuard, wrapArtifactMarkup } from '@/buzz/artifact';
import {
  artifactPdfLocalUri,
  fetchArtifactBytes,
  fetchArtifactText,
  openArtifactInBrowserOrExplain,
} from '@/buzz/artifact-link';
import { artifactWebViewProps } from '@/components/buzz/artifact-webview';
import { useSandboxWebView } from '@/components/buzz/sandbox-webview';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { groknight } from '@/buzz/groknight';

/**
 * The full-screen artifact viewer (mock 1c): the whole page, still script off,
 * still no network beyond the initial string load, still guarded — exactly one
 * navigation passes the gate, everything after it is refused. Markdown
 * renders through the app's own renderer; a PDF rides a local cache file on
 * iOS and the system viewer on Android (the modal closes once the handoff
 * fires). Nothing here ever receives an onMessage bridge.
 */
export function ArtifactViewerScreen({
  attachment,
  onClose,
}: {
  attachment: AttachmentReference;
  authorHandle?: string;
  onClose: () => void;
}) {
  const format = artifactFormat(attachment.mimeType);
  const title = attachment.title ?? attachment.name;
  return (
    <View style={styles.screen} testID="artifact-viewer">
      <View style={styles.header}>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {title}
        </Text>
        <Pressable
          accessibilityLabel="Close artifact viewer"
          accessibilityRole="button"
          onPress={onClose}
          testID="artifact-viewer-close"
        >
          <Text style={styles.headerClose}>✕</Text>
        </Pressable>
      </View>
      <View style={styles.body}>
        {format === 'markdown' ? (
          <ArtifactViewerMarkdown attachment={attachment} />
        ) : format === 'pdf' && Platform.OS !== 'ios' ? (
          <ArtifactSystemHandoff attachment={attachment} onClose={onClose} />
        ) : (
          <ArtifactViewerSandbox attachment={attachment} format={format} />
        )}
      </View>
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
  const [failed, setFailed] = useState(false);
  const guardRef = useRef(createInitialLoadGuard());
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if (format === 'pdf') {
          setSource({ uri: await artifactPdfLocalUri(attachment) });
          return;
        }
        if (format === 'html' || format === 'svg') {
          const bytes = await fetchArtifactBytes(attachment);
          setSource({ html: wrapArtifactMarkup(new TextDecoder().decode(bytes), format) });
          return;
        }
        setFailed(true);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [attachment, format]);
  const WebView = useSandboxWebView();
  if (failed) {
    return (
      <View style={styles.placeholder} testID="artifact-viewer-failed">
        <Text style={styles.placeholderText}>The page could not be loaded. Try again.</Text>
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

/** Android PDF: one handoff to the system viewer through the signed link, then the modal closes. */
function ArtifactSystemHandoff({
  attachment,
  onClose,
}: {
  attachment: AttachmentReference;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(true);
  useEffect(() => {
    let live = true;
    void openArtifactInBrowserOrExplain(attachment).finally(() => {
      if (live) onClose();
    });
    return () => {
      live = false;
    };
  }, [attachment, onClose]);
  return (
    <View style={styles.placeholder} testID="artifact-viewer-handoff">
      <Text style={styles.placeholderText}>{pending ? 'Opening…' : ''}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.space.md,
    paddingTop: theme.buzz.space.md,
    paddingBottom: theme.buzz.space.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.buzz.border,
  },
  headerTitle: {
    ...groknight.type.bodyStrong,
    color: groknight.textPrimary,
    flex: 1,
    minWidth: 0,
  },
  headerClose: { ...groknight.type.body, color: groknight.ledgerQuiet },
  body: { flex: 1 },
  webview: { flex: 1, backgroundColor: 'transparent' },
  markdownBody: { padding: theme.buzz.space.md },
  markdownText: { ...groknight.type.body, color: groknight.textPrimary },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  placeholderText: { ...groknight.type.meta, color: groknight.ledgerQuiet },
}));
