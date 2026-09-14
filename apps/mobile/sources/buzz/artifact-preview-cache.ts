import type { RefObject } from 'react';
import type { View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import { cacheDirectory, getInfoAsync, moveAsync } from 'expo-file-system/legacy';

import { mediaIdFromUrl } from '@/buzz/artifact';

/**
 * The mobile card IS the preview: the artifact renders on the device once,
 * script off, cropped to a fixed height, then is snapshotted to an image and
 * cached on the device keyed by the object id. Every later mount — scrolling
 * away and back, re-entering the Room — shows the cached image, never a second
 * render. The in-memory set closes the render-twice window across mounts of
 * the same session; the cache file survives restarts.
 */
const inFlight = new Set<string>();

export function artifactPreviewCachePath(objectId: string): string {
  if (!cacheDirectory) throw new Error('No cache directory is available for artifact previews.');
  return `${cacheDirectory}artifact-preview-${objectId.replace(/[^0-9a-zA-Z-]/g, '')}.png`;
}

/** Resolves to the snapshot path once one capture has landed, or null when nothing could be captured. */
export async function snapshotArtifactPreview(
  attachmentUrl: string,
  viewRef: RefObject<View | null>,
): Promise<string | null> {
  const objectId = mediaIdFromUrl(attachmentUrl);
  if (!objectId || inFlight.has(objectId)) return null;
  // The marker is set synchronously, before any await: two mounts of the same
  // card in one frame must not both reach the renderer.
  inFlight.add(objectId);
  try {
    const cached = await existingPreview(objectId);
    if (cached) return cached;
    if (viewRef.current == null) return null;
    const uri = await captureRef(viewRef.current, { format: 'png', quality: 1, result: 'tmpfile' });
    const target = artifactPreviewCachePath(objectId);
    await moveAsync({ from: uri, to: target });
    return target;
  } catch {
    return null;
  } finally {
    inFlight.delete(objectId);
  }
}

/** The cached snapshot for this object, or null when none has been captured yet. */
export async function probeArtifactPreview(attachmentUrl: string): Promise<string | null> {
  const objectId = mediaIdFromUrl(attachmentUrl);
  return objectId ? existingPreview(objectId) : null;
}

async function existingPreview(objectId: string): Promise<string | null> {
  try {
    const path = artifactPreviewCachePath(objectId);
    const info = await getInfoAsync(path);
    return info.exists ? path : null;
  } catch {
    return null;
  }
}

/** Test seam: forget the session's in-flight markers so a test can re-capture. */
export function resetArtifactPreviewCache(): void {
  inFlight.clear();
}
