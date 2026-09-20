import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AttachmentReference } from '@beeline/buzz-client';

import { createInitialLoadGuard } from '@/buzz/artifact';
import {
  ARTIFACT_PDF_BASE_URL,
  ARTIFACT_PDF_FAILURE_TEXT,
  loadPdfViewerDocument,
  type ArtifactPdfMode,
} from '@/buzz/artifact-pdf';
import { artifactBase64 } from '@/buzz/artifact-link';
import { artifactWebViewProps } from '@/components/buzz/artifact-webview';
import { useSandboxWebView, useSandboxWebViewStatus } from '@/components/buzz/sandbox-webview';

/**
 * A PDF painted in the app, on the two surfaces whose host can paint one: the
 * Android WebView and the desktop work pane's frame. Both take the same
 * generated document (`buzz/artifact-pdf.ts`) — the vendored pdf.js build and
 * the file's bytes as base64 — and both give it a real origin, which is what
 * pdf.js needs to finish loading at all.
 *
 * iOS never reaches here: its WebView renders a PDF from the cache file
 * directly, which is both cheaper and already shipped.
 */
export function ArtifactPdfView({
  attachment,
  mode,
  onLoadEnd,
  testID = 'artifact-pdf-view',
}: {
  attachment: AttachmentReference;
  mode: ArtifactPdfMode;
  onLoadEnd?: () => void;
  testID?: string;
}) {
  const [documentHtml, setDocumentHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const guardRef = useRef(createInitialLoadGuard());
  useEffect(() => {
    let live = true;
    setDocumentHtml(null);
    setFailed(false);
    void (async () => {
      try {
        const pdfBase64 = await artifactBase64(attachment);
        const html = await loadPdfViewerDocument({ pdfBase64, mode });
        if (live) setDocumentHtml(html);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [attachment, mode]);
  if (failed) {
    return (
      <View style={styles.placeholder} testID="artifact-pdf-failed">
        <Text style={styles.placeholderText}>{ARTIFACT_PDF_FAILURE_TEXT}</Text>
      </View>
    );
  }
  if (Platform.OS === 'web') {
    return <ArtifactPdfFrame documentHtml={documentHtml} name={attachment.name} testID={testID} />;
  }
  return (
    <ArtifactPdfWebView
      documentHtml={documentHtml}
      guard={guardRef.current}
      onLoadEnd={onLoadEnd}
      scrollEnabled={mode === 'viewer'}
      testID={testID}
    />
  );
}

/**
 * Desktop: the document rides a blob URL rather than `srcdoc`, because a
 * `srcdoc` frame's origin leaves pdf.js' module load hanging on a blank page.
 * The HTML/SVG pane keeps its fully sandboxed `srcdoc` frame — that one is
 * rendering markup an artifact author wrote, and this one never is.
 */
function ArtifactPdfFrame({
  documentHtml,
  name,
  testID,
}: {
  documentHtml: string | null;
  name: string;
  testID: string;
}) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  useEffect(() => {
    if (documentHtml == null) {
      setFrameUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([documentHtml], { type: 'text/html' }));
    setFrameUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [documentHtml]);
  if (!frameUrl) return <ArtifactPdfLoading />;
  return React.createElement('iframe', {
    src: frameUrl,
    style: pdfFrameStyle,
    title: name,
    'data-testid': testID,
  });
}

/** Android: the same document, with the origin supplied by the base URL. */
function ArtifactPdfWebView({
  documentHtml,
  guard,
  onLoadEnd,
  scrollEnabled,
  testID,
}: {
  documentHtml: string | null;
  guard: { allow(requestUrl: string): boolean };
  onLoadEnd?: () => void;
  scrollEnabled: boolean;
  testID: string;
}) {
  const WebView = useSandboxWebView();
  const status = useSandboxWebViewStatus();
  if (documentHtml != null && !WebView && status === 'unavailable') {
    return (
      <View style={styles.placeholder} testID="artifact-pdf-failed">
        <Text style={styles.placeholderText}>{ARTIFACT_PDF_FAILURE_TEXT}</Text>
      </View>
    );
  }
  if (documentHtml == null || !WebView) return <ArtifactPdfLoading />;
  return (
    <WebView
      {...artifactWebViewProps({
        source: { html: documentHtml, baseUrl: ARTIFACT_PDF_BASE_URL },
        guard,
        scrollEnabled,
        // The renderer itself is script — the artifact is not. See the note on
        // the generated document for what that trades and what it keeps.
        javaScript: true,
      })}
      onLoadEnd={onLoadEnd}
      style={styles.webview}
      testID={testID}
    />
  );
}

function ArtifactPdfLoading() {
  return (
    <View style={styles.placeholder} testID="artifact-pdf-loading">
      <Text style={styles.placeholderText}>Loading…</Text>
    </View>
  );
}

const pdfFrameStyle: React.CSSProperties = {
  border: 'none',
  width: '100%',
  height: '100%',
  backgroundColor: '#ffffff',
};

const styles = StyleSheet.create((theme) => ({
  webview: { flex: 1, backgroundColor: '#ffffff' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: theme.buzz.space.md },
  placeholderText: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, textAlign: 'center' },
}));
