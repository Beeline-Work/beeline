import React, { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AttachmentReference } from '@beeline/buzz-client';

import { artifactFormat, createInitialLoadGuard, wrapArtifactMarkup } from '@/buzz/artifact';
import { fetchArtifactBytes, fetchArtifactText, openArtifactInBrowserOrExplain } from '@/buzz/artifact-link';
import { formatAttachmentSize } from '@/buzz/chat-attachment';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { groknight } from '@/buzz/groknight';

/**
 * The desktop work pane's artifact view (mock 1c, desktop): the page rendered
 * in a sandboxed iframe — `sandbox` carries neither `allow-scripts` nor
 * `allow-same-origin`, so the page cannot execute or reach storage. The bytes
 * ride `srcdoc`, never a URL; the guard vocabulary stays the same one-shot
 * gate the mobile viewer uses. A PDF cannot render inside a fully sandboxed
 * frame, so the pane offers the signed browser link instead.
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
        {format === 'pdf' || format === 'document' ? (
          <Pressable
            accessibilityLabel="Open in browser"
            accessibilityRole="link"
            onPress={() => void openArtifactInBrowserOrExplain(attachment)}
            testID="desktop-artifact-open-browser"
          >
            <Text style={styles.openLink}>Open in browser ↗</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityLabel="Close artifact pane"
          accessibilityRole="button"
          onPress={onClose}
          testID="desktop-artifact-close"
        >
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>
      {format === 'markdown' ? (
        <DesktopArtifactMarkdown attachment={attachment} />
      ) : format === 'html' || format === 'svg' ? (
        <DesktopArtifactFrame attachment={attachment} format={format} />
      ) : (
        <View style={styles.placeholder} testID="desktop-artifact-handoff">
          <Text style={styles.placeholderText}>
            This format opens in your browser — the pane cannot sandbox it.
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
      <MonoMarkdown markdown={markdown} />
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
  title: { ...groknight.type.bodyStrong, color: groknight.textPrimary },
  kindLine: { ...groknight.type.machine, color: groknight.ledgerQuiet },
  openLink: { ...groknight.type.body, color: groknight.accent },
  close: { ...groknight.type.body, color: groknight.ledgerQuiet },
  markdownBody: { padding: theme.buzz.space.md },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: theme.buzz.space.md },
  placeholderText: { ...groknight.type.meta, color: groknight.ledgerQuiet, textAlign: 'center' },
}));
