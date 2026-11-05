import { Platform } from 'react-native';
import { readArtifactObject, artifactObjectLocalUri, subscribeArtifactBytesPurge, type ArtifactByteOptions } from './artifact-byte-owner';
import { bytesToBase64 } from './byte-base64';
import { requestMediaLink, requestMediaPlayback } from './media-cache-connection';

import { Modal } from '@/modal';
import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { mediaIdFromUrl } from '@/buzz/artifact';
import { openExternalUrl } from '@/utils/open-external-url';
import type { AttachmentReference } from '@beeline/buzz-client';
export { subscribeArtifactBytesPurge };
export type { ArtifactByteOptions };

/**
 * Artifact transport: bytes for in-app rendering come through the app's
 * authenticated session (the canonical `/v1/media/<id>` may answer a 302 to a
 * signed storage link — fetch follows it); "Open in browser" mints a
 * ten-minute signed link through `GET /v1/media/<id>/link` at tap time, so
 * Chrome gets a URL it can read without the app's bearer token.
 *
 * An attachment's stored url is caller-supplied text, so it is read for its
 * media id and thrown away: every request is rebuilt against the configured
 * monolith origin. An absolute url is never followed, because this session's
 * bearer token belongs to that origin alone and any host can serve a
 * `/v1/media/<id>` path.
 */
export function artifactMediaUrl(attachment: AttachmentReference): string {
  const objectId = mediaIdFromUrl(attachment.url);
  if (!objectId) throw new Error('attachment is not a monolith media URL');
  return `${getBuzzRuntimeConfig().monolithUrl}/v1/media/${objectId}`;
}

/**
 * Images use the same authenticated byte flight as view/save. Native receives
 * an owned local cache URI; web receives an object URL which the caller
 * revokes with `releaseArtifactImageSource`.
 */
export async function artifactImageSource(attachment: AttachmentReference, options: ArtifactByteOptions = {}): Promise<{
  uri: string;
  headers?: { authorization: string };
}> {
  const value = await readObject(attachment, options);
  if (options.signal?.aborted || !value.isCurrent()) throw new Error('The file is no longer visible.');
  if (Platform.OS === 'web') return {
    uri: URL.createObjectURL(new Blob([value.bytes as unknown as BlobPart], { type: value.mimeType })),
  };
  // Native decodes the exact same authenticated immutable bytes as the web,
  // viewer and save paths. It never starts an untracked Image HTTP request.
  const uri = await artifactObjectLocalUri(value.key);
  if (options.signal?.aborted || !value.isCurrent()) throw new Error('The file is no longer visible.');
  return { uri };
}

/** Frees an object URL minted above; a native uri is left alone. */
export function releaseArtifactImageSource(source: { uri: string } | null | undefined): void {
  if (source?.uri.startsWith('blob:')) URL.revokeObjectURL(source.uri);
}

/** The file's bytes as base64, for the hosts that take a PDF as a string. */
export async function artifactBase64(attachment: AttachmentReference, options: ArtifactByteOptions = {}): Promise<string> {
  return bytesToBase64(await fetchArtifactBytes(attachment, options));
}

async function readObject(attachment: AttachmentReference, options: ArtifactByteOptions) {
  return readArtifactObject(attachment, async (objectId, signal, maxBytes) => {
    const response = await monolithSession.fetch(`${getBuzzRuntimeConfig().monolithUrl}/v1/media/${objectId}`, { signal }, { timeoutMs: 20_000 });
    if (!response.ok) throw new Error(`artifact fetch failed: ${response.status}`);
    const length = response.headers?.get('content-length');
    if (length && Number(length) > maxBytes) throw new Error('The file exceeds its byte limit.');
    const reader = response.body?.getReader?.();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error('The file exceeds its byte limit.');
      return bytes;
    }
    const parts: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new Error('The file is no longer visible.');
        const { done, value } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error('The file exceeds its byte limit.');
        parts.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return bytes;
  }, options);
}
export async function fetchArtifactBytes(attachment: AttachmentReference, options: ArtifactByteOptions = {}): Promise<Uint8Array> {
  return (await readObject(attachment, options)).bytes;
}
export async function fetchArtifactText(attachment: AttachmentReference, options: ArtifactByteOptions = {}): Promise<string> {
  return new TextDecoder().decode(await fetchArtifactBytes(attachment, options));
}
export async function artifactLocalUri(attachment: AttachmentReference, options: ArtifactByteOptions = {}): Promise<string> {
  const value = await readObject(attachment, options);
  const uri = await artifactObjectLocalUri(value.key);
  if (options.signal?.aborted || !value.isCurrent()) throw new Error('The file is no longer visible.');
  return uri;
}

interface ArtifactLinkResponse {
  url?: string;
  link?: string;
}

/** Only the trusted app mints capabilities. The game receives no bearer. */
export async function runnableArtifactUrl(attachment: AttachmentReference): Promise<string> {
  const objectId = mediaIdFromUrl(attachment.url);
  if (!objectId) throw new Error('attachment is not a monolith media URL');
  const value = await requestMediaPlayback(objectId);
  const { url } = value;
  const game = new URL(url);
  const app = new URL(getBuzzRuntimeConfig().monolithUrl);
  if (game.protocol !== 'https:' || game.origin === app.origin ||
      game.hostname === 'usebeeline.app' || game.hostname.endsWith('.usebeeline.app') ||
      game.username || game.password || !/^\/play\/[0-9a-f-]{36}$/.test(game.pathname)) {
    throw new Error('The interactive page host is not isolated.');
  }
  return game.href;
}

export async function openArtifactInBrowser(attachment: AttachmentReference): Promise<void> {
  const objectId = mediaIdFromUrl(attachment.url);
  if (!objectId) throw new Error('attachment is not a monolith media URL');
  const body = await requestMediaLink(objectId);
  const url = body.url ?? ('link' in body ? body.link : undefined);
  if (!url) throw new Error('artifact link response carried no URL');
  await openExternalUrl(url);
}

/** Lands the PDF bytes in a cache file so an iOS preview can render page one locally. */
export async function artifactPdfLocalUri(attachment: AttachmentReference, options: ArtifactByteOptions = {}): Promise<string> {
  return artifactLocalUri(attachment, options);
}

/** Opens the signed link and folds every failure into one spoken outcome. */
export async function openArtifactInBrowserOrExplain(attachment: AttachmentReference): Promise<void> {
  try {
    await openArtifactInBrowser(attachment);
  } catch {
    Modal.alert('Could not open in browser', 'The signed link could not be minted. Try again.');
  }
}
