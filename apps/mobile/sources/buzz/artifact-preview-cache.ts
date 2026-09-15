import type { RefObject } from 'react';
import type { View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import {
  cacheDirectory,
  deleteAsync,
  EncodingType,
  getInfoAsync,
  moveAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';

import { mediaIdFromUrl } from '@/buzz/artifact';

/**
 * The mobile card IS the preview: the artifact renders on the device once,
 * script off, cropped to a fixed height, then is snapshotted to an image and
 * cached on the device keyed by the object id. Every later mount — scrolling
 * away and back, re-entering the Room — shows the cached image, never a second
 * render. The in-memory set closes the render-twice window across mounts of
 * the same session; the cache file survives restarts.
 *
 * The snapshot must never catch the WebView before its first paint: the
 * compositor draws AFTER `onLoadEnd` fires, so a capture taken right at load
 * end can be a uniform blank — and moving that into the cache would show the
 * blank thumbnail forever. A capture is only accepted once two consecutive
 * captures of the surface agree byte-for-byte (a not-yet-painted surface and
 * a settled page produce different files; a settled page produces identical
 * ones), bounded so a page that keeps animating still gets one cached capture.
 */
const inFlight = new Set<string>();

/** Gap between the two captures whose agreement proves the surface settled. */
export const CAPTURE_SETTLE_MS = 400;
/** Bounded rounds so a continuously animating page still caches something. */
export const CAPTURE_MAX_ROUNDS = 4;

export function artifactPreviewCachePath(objectId: string): string {
  if (!cacheDirectory) throw new Error('No cache directory is available for artifact previews.');
  return `${cacheDirectory}artifact-preview-${objectId.replace(/[^0-9a-zA-Z-]/g, '')}-v2.png`;
}

/** Pre-fix devices hold captures that may be a blank first-paint race; they are re-captured once. */
function legacyArtifactPreviewPath(objectId: string): string {
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
    let previous: string | null = null;
    for (let round = 0; round < CAPTURE_MAX_ROUNDS; round++) {
      if (viewRef.current == null) break;
      const uri = await captureRef(viewRef.current, { format: 'png', quality: 1, result: 'tmpfile' });
      if (previous !== null && (await filesMatch(previous, uri))) {
        // Two consecutive captures agree — the surface has settled.
        const target = artifactPreviewCachePath(objectId);
        await moveAsync({ from: uri, to: target });
        return target;
      }
      previous = uri;
      await settleDelay();
    }
    if (previous == null || viewRef.current == null) return null;
    // Bounded: a page that never settles twice in a row still caches one capture.
    const target = artifactPreviewCachePath(objectId);
    await moveAsync({ from: previous, to: target });
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
    if (info.exists) return path;
    // Heal pre-fix installs: the legacy file may be a blank capture; deleting
    // it forces the settled capture below to replace it.
    const legacyInfo = await getInfoAsync(legacyArtifactPreviewPath(objectId));
    if (legacyInfo.exists) {
      try {
        await deleteAsync(legacyArtifactPreviewPath(objectId));
      } catch {
        // A contested delete only costs one extra stale file.
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Two tmpfiles match when their bytes match (base64 of a PNG compares as text). */
async function filesMatch(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    const [aBytes, bBytes] = await Promise.all([
      readAsStringAsync(a, { encoding: EncodingType.Base64 }),
      readAsStringAsync(b, { encoding: EncodingType.Base64 }),
    ]);
    return aBytes === bBytes;
  } catch {
    return false;
  }
}

/** Test seam: the settle gap is injectable so tests do not sleep real time. */
let settle = () => new Promise<void>((resolve) => setTimeout(resolve, CAPTURE_SETTLE_MS));
export function setArtifactCaptureSettleForTests(delayMs: number): void {
  settle = () => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function settleDelay(): Promise<void> {
  return settle();
}


/** Test seam: forget the session's in-flight markers so a test can re-capture. */
export function resetArtifactPreviewCache(): void {
  inFlight.clear();
}
