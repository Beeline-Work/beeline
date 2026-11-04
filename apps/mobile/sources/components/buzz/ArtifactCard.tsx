import { useArtifactRecoveryGeneration } from '@/buzz/use-artifact-recovery';
import { ContentTarget, IndexRow, InlineRow } from './IndexRow';
import { Button } from '@/components/buzz/Button';
import React, { useCallback, useEffect, useState } from 'react';
import { Image, Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AttachmentReference } from '@beeline/buzz-client';

import {
  ARTIFACT_MAX_PREVIEW_HEIGHT,
  artifactCapabilities,
  artifactFormat,
  mediaIdFromUrl,
} from '@/buzz/artifact';
import { routerOwnerArtifactAction } from '@/buzz/router-owner';
import {
  artifactImageSource,
  releaseArtifactImageSource,
  subscribeArtifactBytesPurge,
  fetchArtifactText,
  openArtifactInBrowserOrExplain,
} from '@/buzz/artifact-link';
import { formatAttachmentSize } from '@/buzz/chat-attachment';
import { withAlpha } from '@/buzz/groknight';
import { openArtifactInDesktopWorkPane } from '@/buzz/desktop-artifact-pane';
import { ArtifactImage, ArtifactText } from '@/components/buzz/ArtifactMedia';
import { ArtifactViewerScreen } from '@/components/buzz/ArtifactViewer';
import { currentViewerConversation } from '@/buzz/viewer-conversation';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { Modal } from '@/modal';


/** Reopen the same artifact surface from a card or transcript reference. */
export function openArtifactViewer(attachment: AttachmentReference, isDesktop = false,
  roomId = currentViewerConversation()?.roomId, authorHandle = attachment.author,
  photoAttachments?: readonly AttachmentReference[]) {
  const format = artifactFormat(attachment.mimeType);
  const objectId = mediaIdFromUrl(attachment.url);
  if (objectId) routerOwnerArtifactAction(format === 'game' ? 'RunArtifact' : 'OpenArtifact', objectId);
  // A picture is not a document: every surface opens the same centered
  // full-screen viewer, so desktop reads an image the way mobile does. The
  // work pane keeps its documents — its sandboxed iframe is the right shape
  // for markup and PDFs, not for a raster.
  // When no second pane can take it (a narrow window, a direct message),
  // the document opens in the same full-screen viewer.
  if (
    isDesktop &&
    format !== 'image' &&
    openArtifactInDesktopWorkPane({
      attachment,
      authorHandle,
      roomId,
    })
  )
    return;
  Modal.show({
    component: ArtifactViewerScreen,
    props: {
      attachment,
      authorHandle,
      roomId,
      ...(photoAttachments && photoAttachments.length > 1 ? { photoAttachments } : {}),
    },
    // The viewer is a full-screen surface: the default centered placement
    // constrains width to 460 and no height, collapsing its flex:1 root to
    // nothing — a dimmed room with an invisible viewer.
    placement: 'fill',
  });
}

/**
 * Visible cards use a bounded excerpt or a server-produced thumbnail. Full
 * document rendering belongs to the existing Open action. Hidden transcript
 * rows retain the same frame without starting a byte request.
 */
export const ArtifactCard = React.memo(function ArtifactCard({
  attachment,
  authorHandle,
  isDesktop = false,
  photoAttachments,
  visible = true,
}: {
  visible?: boolean;
  attachment: AttachmentReference;
  authorHandle?: string;
  isDesktop?: boolean;
  /** Live image artifacts carried by the same message. Omitted for one photo. */
  photoAttachments?: readonly AttachmentReference[];
}) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const isPhotoGroup = Boolean(photoAttachments && photoAttachments.length > 1);
  useEffect(() => {
    setPhotoIndex((index) => Math.min(index, Math.max(0, (photoAttachments?.length ?? 1) - 1)));
  }, [photoAttachments?.length]);
  const activeAttachment =
    (isPhotoGroup ? photoAttachments?.[photoIndex] : undefined) ?? attachment;
  const activeAuthorHandle = activeAttachment.author ?? authorHandle;
  const format = artifactFormat(activeAttachment.mimeType);
  const capabilities = artifactCapabilities(
    activeAttachment.mimeType,
    isDesktop ? 'desktop' : Platform.OS === 'ios' ? 'ios' : 'android',
  );
  const title = activeAttachment.title ?? activeAttachment.name;
  const kindWord = format === 'game' ? 'Interactive'
    : format === 'document' ? activeAttachment.mimeType.toLowerCase() : format;
  const kindLine = `${activeAuthorHandle ? `@${activeAuthorHandle.replace(/^@/, '')} · ` : ''}${kindWord} · ${formatAttachmentSize(activeAttachment.size)}`;
  const openInBrowser = useCallback(
    () => void openArtifactInBrowserOrExplain(activeAttachment),
    [activeAttachment],
  );
  const openFull = useCallback(() => {
    openArtifactViewer(activeAttachment, isDesktop, currentViewerConversation()?.roomId,
      activeAuthorHandle, isPhotoGroup ? photoAttachments : undefined);
  }, [activeAttachment, activeAuthorHandle, isDesktop, isPhotoGroup, photoAttachments]);

  // What is left external is what nothing on the device can paint — a ZIP, an
  // octet-stream, anything unrecognized. Those keep the file-style row and the
  // signed browser link, which is the only way to reach their contents.
  if (capabilities.preview === 'external') {
    const actions =
      capabilities.viewer === 'external' ? (['browser'] as const) : (['browser', 'open'] as const);
    return (
      <ArtifactCardShell
        title={title}
        kindLine={kindLine}
        actions={actions}
        onOpenInBrowser={openInBrowser}
        onOpenFull={openFull}
        testID={`artifact-document-${activeAttachment.name}`}
      >
        <View style={styles.docRow} testID="artifact-document-body">
          <Text style={styles.docGlyph}>▧</Text>
          <Text numberOfLines={1} style={styles.docName}>
            {activeAttachment.name} · {formatAttachmentSize(activeAttachment.size)}
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
      testID={isPhotoGroup ? 'artifact-photo-group' : `artifact-${format}-${activeAttachment.name}`}
    >
      <ContentTarget
        accessibilityLabel={`Open ${title} full screen`}
        accessibilityRole="button"
        onPress={openFull}
        style={styles.previewPress}
        testID={`artifact-preview-${activeAttachment.name}`}
      >
        {!visible ? (
          <View style={styles.previewPlaceholder} testID="artifact-preview-loading"><Text style={styles.docGlyph}>▧</Text></View>
        ) : format === 'markdown' ? (
          <ArtifactMarkdownPreview attachment={activeAttachment} />
        ) : format === 'text' ? (
          <View style={styles.preview}>
            <ArtifactText attachment={activeAttachment} crop testID="artifact-preview-text" />
            <View style={styles.previewFade} pointerEvents="none" />
          </View>
        ) : format === 'image' ? (
          <View style={styles.preview}>
            <ArtifactImage
              attachment={activeAttachment}
              fit="cover"
              style={styles.previewImage}
              testID="artifact-preview-image"
            />
            {isPhotoGroup ? (
              <View pointerEvents="box-none" style={styles.photoNavigation}>
                <Pressable
                  accessibilityLabel="Previous photo"
                  accessibilityRole="button"
                  onPress={(event) => {
                    event?.stopPropagation();
                    setPhotoIndex((index) =>
                      index === 0 ? photoAttachments!.length - 1 : index - 1,
                    );
                  }}
                  style={styles.photoNavigationButton}
                  testID="artifact-photo-previous"
                >
                  <ChevronGlyph
                    color={styles.photoNavigationMark.color}
                    direction="left"
                    size={CHEVRON_ROW_SIZE}
                  />
                </Pressable>
                <Text
                  accessibilityLabel={`Photo ${photoIndex + 1} of ${photoAttachments!.length}`}
                  accessibilityLiveRegion="polite"
                  style={styles.photoPosition}
                  testID="artifact-photo-position"
                >
                  {photoIndex + 1} of {photoAttachments!.length}
                </Text>
                <Pressable
                  accessibilityLabel="Next photo"
                  accessibilityRole="button"
                  onPress={(event) => {
                    event?.stopPropagation();
                    setPhotoIndex((index) => (index + 1) % photoAttachments!.length);
                  }}
                  style={styles.photoNavigationButton}
                  testID="artifact-photo-next"
                >
                  <ChevronGlyph
                    color={styles.photoNavigationMark.color}
                    direction="right"
                    size={CHEVRON_ROW_SIZE}
                  />
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : (
          <ArtifactSandboxPreview
            attachment={activeAttachment}
            format={format === 'pdf' ? 'pdf' : format === 'svg' ? 'svg' : 'html'}
          />
        )}
      </ContentTarget>
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
      <InlineRow style={styles.footer}>
        {actions.includes('browser') ? (
          <Button
            accessibilityLabel="Open in browser"
            accessibilityRole="link"
            onPress={onOpenInBrowser}
            testID="artifact-open-browser"
            label="Open in browser"
            destination="external"
            variant="quiet"
            appearance={{ control: undefined, label: styles.footerQuiet }}
          />
        ) : null}
        <View style={styles.footerSpacer} />
        {actions.includes('open') ? (
          <Button
            accessibilityLabel="Open artifact"
            accessibilityRole="link"
            onPress={onOpenFull}
            testID="artifact-open"
            label="Open"
            destination="screen"
            variant="quiet"
            appearance={{ control: undefined, label: styles.footerPrimary }}
          />
        ) : null}
      </InlineRow>
    </View>
  );
}

type SandboxPreviewFormat = 'html' | 'svg' | 'pdf';

/**
 * The existing preview frame paints a bounded server-produced thumbnail.
 * Full markup/PDF rendering starts only through the existing Open action.
 */
export function ArtifactSandboxPreview({
  attachment,
}: {
  attachment: AttachmentReference;
  format: SandboxPreviewFormat;
}) {
  const recovery = useArtifactRecoveryGeneration();
  const [source, setSource] = useState<Awaited<ReturnType<typeof artifactImageSource>> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false); setSource(null);
    let live = true; let loaded: Awaited<ReturnType<typeof artifactImageSource>> | null = null;
    const controller = new AbortController();
    const stopPurge = subscribeArtifactBytesPurge(attachment, () => { controller.abort(); releaseArtifactImageSource(loaded); setSource(null); setFailed(true); });
    // A server-produced bounded thumbnail is the only binary preview. Whole
    // HTML/SVG/PDF bytes belong to the existing explicit Open action.
    void artifactImageSource(attachment, { signal: controller.signal, preview: true, thumbnail: true }).then(value => {
      loaded = value; if (live && !controller.signal.aborted) setSource(value); else releaseArtifactImageSource(value);
    }).catch(() => { if (live && !controller.signal.aborted) setFailed(true); });
    return () => { live = false; controller.abort(); stopPurge(); releaseArtifactImageSource(loaded); };
  }, [attachment, recovery]);
  if (failed) return (
    <View style={styles.failureInset} testID="artifact-preview-failed">
      <IndexRow inset="flush" title="Preview unavailable" description="The page could not be loaded. Try again." />
    </View>
  );
  if (source) return <View style={styles.preview} testID="artifact-preview-snapshot"><Image source={source} resizeMode="cover" onError={() => setFailed(true)} style={styles.previewImage} /></View>;
  return <View style={styles.previewPlaceholder} testID="artifact-preview-loading"><Text style={styles.docGlyph}>▧</Text></View>;
}

/** Markdown renders through the app's own message renderer, cropped to the card. */
export function ArtifactMarkdownPreview({ attachment }: { attachment: AttachmentReference }) {
  const recovery = useArtifactRecoveryGeneration();
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false); setMarkdown(null);
    let live = true;
    const controller = new AbortController();
    const stopPurge = subscribeArtifactBytesPurge(attachment, () => { controller.abort(); setMarkdown(null); setFailed(true); });
    void fetchArtifactText(attachment, { signal: controller.signal, preview: true })
      .then((text) => {
        if (live && !controller.signal.aborted) setMarkdown(text);
      })
      .catch(() => { if (live && !controller.signal.aborted) setFailed(true); });
    return () => {
      live = false; controller.abort(); stopPurge();
    };
  }, [attachment, recovery]);
  if (failed) return (
    <View style={styles.failureInset} testID="artifact-preview-failed">
      <IndexRow inset="flush" title="Preview unavailable" description="The page could not be loaded. Try again." />
    </View>
  );
  if (markdown == null) {
    return (
      <View style={styles.previewPlaceholder} testID="artifact-preview-loading">
        <Text style={styles.docGlyph}>▧</Text>
      </View>
    );
  }
  return (
    <View
      pointerEvents="none"
      style={[styles.preview, styles.markdownCrop]}
      testID="artifact-preview-markdown"
    >
      <MonoMarkdown markdown={markdown} textStyle={styles.markdownText} />
      <View style={styles.previewFade} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  failureInset: { paddingHorizontal: theme.buzz.roomList.edge },
  // The TranscriptCard frame (DESIGN.md → Transcript cards), read from the
  // same tokens: radius 10, 1 px borderStrong, no fill of its own.
  card: {
    minWidth: 0,
    width: '100%',
    marginTop: theme.buzz.transcriptCard.marginTop,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.transcriptCard.cornerRadius,
    overflow: 'hidden',
  },
  previewPress: { minWidth: 0 },
  preview: {
    height: ARTIFACT_MAX_PREVIEW_HEIGHT,
    backgroundColor: theme.buzz.bgHighlight,
  },
  previewImage: { width: '100%', height: '100%' },
  photoNavigation: {
    position: 'absolute',
    left: theme.buzz.space.sm,
    right: theme.buzz.space.sm,
    bottom: theme.buzz.space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  photoNavigationButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.radius,
    backgroundColor: withAlpha(theme.buzz.bgBase, 0.9),
  },
  photoNavigationMark: { color: theme.buzz.textPrimary },
  photoPosition: {
    ...theme.buzz.type.machine,
    color: theme.buzz.textPrimary,
    backgroundColor: withAlpha(theme.buzz.bgBase, 0.9),
    borderRadius: theme.buzz.radius,
    paddingHorizontal: theme.buzz.space.sm,
    paddingVertical: 4,
  },
  previewWeb: { width: '100%', height: '100%', backgroundColor: 'transparent' },
  previewFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 44,
    backgroundColor: withAlpha(theme.buzz.bgBase, 0.8),
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
    gap: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.transcriptCard.side,
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
    paddingHorizontal: theme.buzz.transcriptCard.side,
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
export { mediaIdFromUrl } from '@/buzz/artifact';
