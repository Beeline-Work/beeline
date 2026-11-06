import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AttachmentReference } from '@beeline/buzz-client';
import { useArtifactRecoveryGeneration } from '@/buzz/use-artifact-recovery';
import { ARTIFACT_MAX_PREVIEW_HEIGHT, createInitialLoadGuard, wrapArtifactMarkup } from '@/buzz/artifact';
import { artifactPdfLocalUri, fetchArtifactText, subscribeArtifactBytesPurge } from '@/buzz/artifact-link';
import { artifactWebViewProps } from './artifact-webview';
import { useSandboxWebView, useSandboxWebViewStatus } from './sandbox-webview';
import { ArtifactPdfView } from './ArtifactPdfView';
import { IndexRow } from './IndexRow';

type SandboxPreviewFormat = 'html' | 'svg' | 'pdf';

/** The existing 25 MB byte owner bounds downloads; the card bounds painting. */
export function ArtifactDocumentPreview({ attachment, format }: {
  attachment: AttachmentReference;
  format: SandboxPreviewFormat;
}) {
  const recovery = useArtifactRecoveryGeneration();
  const [source, setSource] = useState<{ html: string } | { uri: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const guardRef = useRef(createInitialLoadGuard());
  const WebView = useSandboxWebView();
  const status = useSandboxWebViewStatus();
  const pdfRenderer = format === 'pdf' && Platform.OS !== 'ios';
  useEffect(() => {
    if (pdfRenderer) return;
    let live = true;
    const controller = new AbortController();
    const stopPurge = subscribeArtifactBytesPurge(attachment, () => {
      controller.abort(); setSource(null); setFailed(true);
    });
    setSource(null); setFailed(false);
    void (async () => {
      try {
        // Read the original, not a text excerpt or raster thumbnail: markup
        // and PDFs must remain complete to render. Open reuses these bytes.
        const next = format === 'pdf'
          ? { uri: await artifactPdfLocalUri(attachment, { signal: controller.signal }) }
          : { html: wrapArtifactMarkup(await fetchArtifactText(attachment, { signal: controller.signal }), format) };
        if (!live || controller.signal.aborted) return;
        guardRef.current = createInitialLoadGuard('uri' in next ? next.uri : undefined);
        setSource(next);
      } catch {
        if (live && !controller.signal.aborted) setFailed(true);
      }
    })();
    return () => { live = false; controller.abort(); stopPurge(); };
  }, [attachment, format, recovery, pdfRenderer]);
  if (failed || source && Platform.OS !== 'web' && status === 'unavailable') {
    return (
      <View style={styles.failureInset} testID="artifact-preview-failed">
        <IndexRow inset="flush" title="Preview unavailable" description="Open the file to view it." />
      </View>
    );
  }
  return (
    <View pointerEvents="none" style={[styles.preview, styles.documentCrop]} testID="artifact-preview-render">
      {pdfRenderer ? <ArtifactPdfView attachment={attachment} mode="preview" /> :
        source && Platform.OS === 'web' && 'html' in source ? React.createElement('iframe', {
          srcDoc: source.html,
          sandbox: '',
          title: attachment.name,
          tabIndex: -1,
          'data-testid': 'artifact-preview-frame',
          style: { border: 'none', width: '100%', height: '100%', pointerEvents: 'none' },
        }) : source && WebView ? (
          <WebView
            {...artifactWebViewProps({ source, guard: guardRef.current })}
            pointerEvents="none"
            style={styles.previewWeb}
            testID="artifact-preview-webview"
          />
        ) : <View style={styles.previewPlaceholder} testID="artifact-preview-loading"><Text style={styles.docGlyph}>▧</Text></View>}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  failureInset: { paddingHorizontal: theme.buzz.roomList.edge },
  preview: { height: ARTIFACT_MAX_PREVIEW_HEIGHT, backgroundColor: theme.buzz.bgHighlight },
  documentCrop: { overflow: 'hidden' },
  previewWeb: { width: '100%', height: '100%', backgroundColor: 'transparent' },
  previewPlaceholder: {
    height: ARTIFACT_MAX_PREVIEW_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.buzz.bgHighlight,
  },
  docGlyph: { ...theme.buzz.type.body, color: theme.buzz.steel },
}));
