import React, { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AttachmentReference } from '@beeline/buzz-client';

import { artifactFormat, wrapArtifactMarkup } from '@/buzz/artifact';
import { fetchArtifactBytes, fetchArtifactText, openArtifactInBrowserOrExplain } from '@/buzz/artifact-link';
import { formatAttachmentSize } from '@/buzz/chat-attachment';
import { copyPicture, sharePicture, showPictureActions } from '@/buzz/picture-actions';
import { ArtifactImage, ArtifactText } from '@/components/buzz/ArtifactMedia';
import { ArtifactPdfView } from '@/components/buzz/ArtifactPdfView';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';

/**
 * The desktop work pane's artifact view (mock 1c, desktop): markup rendered in
 * a sandboxed iframe — `sandbox` carries neither `allow-scripts` nor
 * `allow-same-origin`, so the page cannot execute or reach storage, and the
 * bytes ride `srcdoc`, never a URL. Markdown, plain text and rasters render
 * through the app's own views. A PDF renders through the vendored pdf.js
 * document in its own frame, which is why that one is not the fully sandboxed
 * frame — see `buzz/artifact-pdf.ts` for what that trades and what it keeps.
 *
 * `Open in browser` stays on every format, not only the ones the pane cannot
 * paint: the signed link is the fallback when a render fails and the way out
 * for a reader who wants the file in a tab of their own.
 */
export function DesktopArtifactPane({
  attachment,
  authorHandle,
  onClose,
}: {
  attachment: AttachmentReference;
  authorHandle?: string;
  onClose(): void;
}) {
  const format = artifactFormat(attachment.mimeType);
  const title = attachment.title ?? attachment.name;
  const kindLine = `${authorHandle ? `@${authorHandle.replace(/^@/, '')} · ` : ''}${format} · ${formatAttachmentSize(attachment.size)}`;
  return (
    <View style={styles.screen} testID="desktop-artifact-pane">
      <View style={styles.header}>
        <View style={styles.caption}>
          <Text numberOfLines={1} style={styles.title} testID="desktop-artifact-title">
            {title}
          </Text>
          <Text numberOfLines={1} style={styles.kindLine} testID="desktop-artifact-kind-line">
            {kindLine}
          </Text>
        </View>
        {format === 'image' ? (
          <>
            <Pressable
              accessibilityLabel="Copy image"
              accessibilityRole="button"
              onPress={() => void copyPicture(attachment)}
              style={styles.headerAction}
              testID="desktop-artifact-copy"
            >
              <Text style={styles.actionText}>Copy</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Share image"
              accessibilityRole="button"
              onPress={() => void sharePicture(attachment)}
              style={styles.headerAction}
              testID="desktop-artifact-share"
            >
              <Text style={styles.actionText}>Share</Text>
            </Pressable>
          </>
        ) : null}
        <Pressable
          accessibilityLabel="Open in browser"
          accessibilityRole="link"
          onPress={() => void openArtifactInBrowserOrExplain(attachment)}
          style={styles.headerAction}
          testID="desktop-artifact-open-browser"
        >
          <Text style={styles.openLink}>Open in browser ↗</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Close artifact pane"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.headerAction}
          testID="desktop-artifact-close"
        >
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>
      {format === 'markdown' ? (
        <DesktopArtifactMarkdown attachment={attachment} />
      ) : format === 'html' || format === 'svg' ? (
        <DesktopArtifactFrame attachment={attachment} format={format} />
      ) : format === 'image' ? (
        <Pressable
          accessibilityLabel={`Image ${title}`}
          style={styles.image}
          testID="desktop-artifact-image-actions"
          {...({
            onContextMenu: (event: { preventDefault(): void }) => {
              event.preventDefault();
              showPictureActions(attachment);
            },
          } as any)}
        >
          <ArtifactImage
            attachment={attachment}
            fit="contain"
            style={styles.image}
            testID="desktop-artifact-image"
          />
        </Pressable>
      ) : format === 'text' ? (
        <ArtifactText attachment={attachment} crop={false} testID="desktop-artifact-text" />
      ) : format === 'pdf' ? (
        <ArtifactPdfView attachment={attachment} mode="viewer" testID="desktop-artifact-pdf" />
      ) : (
        <View style={styles.placeholder} testID="desktop-artifact-handoff">
          <Text style={styles.placeholderText}>
            This format opens in your browser — the pane cannot render it.
          </Text>
        </View>
      )}
    </View>
  );
}

/** HTML/SVG: fetched bytes, CSP meta first, rendered from srcdoc with no script origin. */
export function DesktopArtifactFrame({
  attachment,
  format,
}: {
  attachment: AttachmentReference;
  format: 'html' | 'svg';
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void fetchArtifactBytes(attachment)
      .then((bytes) => {
        if (live) setHtml(wrapArtifactMarkup(new TextDecoder().decode(bytes), format));
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [attachment, format]);
  if (failed) {
    return (
      <View style={styles.placeholder} testID="desktop-artifact-failed">
        <Text style={styles.placeholderText}>The page could not be loaded. Try again.</Text>
      </View>
    );
  }
  if (html == null) {
    return (
      <View style={styles.placeholder} testID="desktop-artifact-loading">
        <Text style={styles.placeholderText}>Loading…</Text>
      </View>
    );
  }
  if (Platform.OS === 'web') {
    return React.createElement('iframe', {
      srcDoc: html,
      sandbox: '',
      style: sandboxedFrameStyle,
      title: attachment.name,
      'data-testid': 'desktop-artifact-frame',
    });
  }
  return (
    <View style={styles.placeholder} testID="desktop-artifact-loading">
      <Text style={styles.placeholderText}>Loading…</Text>
    </View>
  );
}

function DesktopArtifactMarkdown({ attachment }: { attachment: AttachmentReference }) {
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
      <View style={styles.placeholder} testID="desktop-artifact-failed">
        <Text style={styles.placeholderText}>The page could not be loaded. Try again.</Text>
      </View>
    );
  }
  if (markdown == null) {
    return (
      <View style={styles.placeholder} testID="desktop-artifact-loading">
        <Text style={styles.placeholderText}>Loading…</Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.markdownBody} testID="desktop-artifact-markdown">
      <MonoMarkdown markdown={markdown} textStyle={styles.markdownText} />
    </ScrollView>
  );
}

const sandboxedFrameStyle: React.CSSProperties = {
  border: 'none',
  width: '100%',
  height: '100%',
  backgroundColor: '#ffffff',
};

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.space.md,
    paddingVertical: theme.buzz.space.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.buzz.border,
  },
  caption: { flex: 1, minWidth: 0 },
  title: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  kindLine: { ...theme.buzz.type.machine, color: theme.buzz.ledgerQuiet },
  openLink: { ...theme.buzz.type.body, color: theme.buzz.accent },
  headerAction: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  close: { ...theme.buzz.type.body, color: theme.buzz.ledgerQuiet },
  image: { flex: 1, width: '100%', height: '100%' },
  markdownBody: { padding: theme.buzz.space.md },
  markdownText: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: theme.buzz.space.md },
  placeholderText: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, textAlign: 'center' },
}));
