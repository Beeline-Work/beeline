import { IndexRow } from '@/components/buzz/IndexRow';
import { useArtifactRecoveryGeneration } from '@/buzz/use-artifact-recovery';
import React, { useEffect, useState } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AttachmentReference } from '@beeline/buzz-client';

import { artifactTextPreview } from '@/buzz/artifact';
import {
  artifactImageSource,
  fetchArtifactText,
  releaseArtifactImageSource,
  subscribeArtifactBytesPurge,
} from '@/buzz/artifact-link';

type ImageSource = Awaited<ReturnType<typeof artifactImageSource>>;

/**
 * A raster artifact — PNG, JPEG, GIF, WebP — painted wherever the artifact
 * appears: cropped to the card as its own thumbnail, and fitted whole in the
 * viewer and the desktop pane. The bytes come through the app's session on
 * every surface, so nothing here leans on the signed browser link; the card's
 * `Open in browser` keeps that path for the reader who wants it.
 */
export function ArtifactImage({
  attachment,
  fit,
  onLoadImageSize,
  style,
  testID,
}: {
  attachment: AttachmentReference;
  fit: 'cover' | 'contain';
  onLoadImageSize?: (width: number, height: number) => void;
  style?: object;
  testID: string;
}) {
  const recovery = useArtifactRecoveryGeneration();
  const [source, setSource] = useState<ImageSource | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let loaded: ImageSource | null = null;
    const controller = new AbortController();
    const stopPurge = subscribeArtifactBytesPurge(attachment, () => {
      controller.abort(); releaseArtifactImageSource(loaded); setSource(null); setFailed(true);
    });
    setFailed(false);
    setSource(null);
    void artifactImageSource(attachment, { signal: controller.signal, preview: fit === 'cover' })
      .then((next) => {
        loaded = next;
        if (live && !controller.signal.aborted) setSource(next);
        else releaseArtifactImageSource(next);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false; controller.abort(); stopPurge();
      releaseArtifactImageSource(loaded);
    };
  }, [attachment, fit, recovery]);
  if (failed) {
    return (
      <View style={[styles.failureInset, style]} testID="artifact-image-failed">
        <IndexRow inset="flush" title="Image unavailable" description={"The image could not be loaded. Try again."} />
      </View>
    );
  }
  if (!source) {
    return (
      <View style={[styles.placeholder, style]} testID="artifact-image-loading">
        <Text style={styles.placeholderText}>Loading…</Text>
      </View>
    );
  }
  return (
    <Image
      accessibilityIgnoresInvertColors
      accessibilityLabel={attachment.title ?? attachment.name}
      onLoad={(event) => {
        const native = event.nativeEvent as typeof event.nativeEvent & {
          target?: { naturalWidth?: number; naturalHeight?: number };
        };
        const width = native.source?.width ?? native.target?.naturalWidth ?? 0;
        const height = native.source?.height ?? native.target?.naturalHeight ?? 0;
        if (width > 0 && height > 0) onLoadImageSize?.(width, height);
      }}
      onError={() => setFailed(true)}
      resizeMode={fit}
      source={source}
      style={style}
      testID={testID}
    />
  );
}

/**
 * Plain text, JSON and CSV read in the app rather than in a browser tab: the
 * file's own characters in the machine face, cropped on the card and whole in
 * the viewer. No reformatting and no highlighting — a JSON artifact reads as
 * the author wrote it, and a CSV's columns stay the columns in the file.
 */
export function ArtifactText({
  attachment,
  crop,
  testID,
}: {
  attachment: AttachmentReference;
  crop: boolean;
  testID: string;
}) {
  const recovery = useArtifactRecoveryGeneration();
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const stopPurge = subscribeArtifactBytesPurge(attachment, () => { controller.abort(); setText(null); setFailed(true); });
    setText(null); setFailed(false);
    void fetchArtifactText(attachment, { signal: controller.signal, preview: crop })
      .then((next) => {
        if (live && !controller.signal.aborted) setText(next);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false; controller.abort(); stopPurge();
    };
  }, [attachment, crop, recovery]);
  if (failed) {
    return (
      <View style={styles.failureInset} testID="artifact-text-failed">
        <IndexRow inset="flush" title="File unavailable" description={"The file could not be loaded. Try again."} />
      </View>
    );
  }
  if (text == null) {
    return (
      <View style={styles.placeholder} testID="artifact-text-loading">
        <Text style={styles.placeholderText}>Loading…</Text>
      </View>
    );
  }
  if (crop) {
    return (
      <View pointerEvents="none" style={styles.crop} testID={testID}>
        <Text style={styles.body}>{artifactTextPreview(text)}</Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.scrollBody} testID={testID}>
      <Text selectable style={styles.body}>
        {text}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  failureInset: { paddingHorizontal: theme.buzz.roomList.edge },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.buzz.space.md,
  },
  placeholderText: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, textAlign: 'center' },
  crop: { flex: 1, overflow: 'hidden', padding: theme.buzz.space.sm },
  scrollBody: { padding: theme.buzz.space.md },
  body: { ...theme.buzz.type.machine, color: theme.buzz.textPrimary },
}));
