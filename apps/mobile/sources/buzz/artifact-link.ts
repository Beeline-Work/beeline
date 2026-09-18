import { Modal } from '@/modal';
import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { mediaIdFromUrl } from '@/buzz/artifact';
import { openExternalUrl } from '@/utils/open-external-url';
import type { AttachmentReference } from '@beeline/buzz-client';
import { cacheDirectory, writeAsStringAsync, EncodingType } from 'expo-file-system/legacy';

/**
 * Artifact transport: bytes for in-app rendering come through the app's
 * authenticated session (the canonical `/v1/media/<id>` may answer a 302 to a
 * signed storage link — fetch follows it); "Open in browser" mints a
 * ten-minute signed link through `GET /v1/media/<id>/link` at tap time, so
 * Chrome gets a URL it can read without the app's bearer token.
 */
export function artifactMediaUrl(attachment: AttachmentReference): string {
  const base = getBuzzRuntimeConfig().monolithUrl;
  return attachment.url.startsWith('http') ? attachment.url : `${base}${attachment.url}`;
}

/** Native images load the authenticated artifact route without leaving the app. */
export async function artifactImageSource(attachment: AttachmentReference): Promise<{
  uri: string;
  headers: { authorization: string };
}> {
  return {
    uri: artifactMediaUrl(attachment),
    headers: { authorization: `Bearer ${await monolithSession.authorization()}` },
  };
}

export async function fetchArtifactBytes(attachment: AttachmentReference): Promise<Uint8Array> {
  const response = await monolithSession.fetch(artifactMediaUrl(attachment), {}, { timeoutMs: 20_000 });
  if (!response.ok) throw new Error(`artifact fetch failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function fetchArtifactText(attachment: AttachmentReference): Promise<string> {
  const response = await monolithSession.fetch(artifactMediaUrl(attachment), {}, { timeoutMs: 20_000 });
  if (!response.ok) throw new Error(`artifact fetch failed: ${response.status}`);
  return response.text();
}

interface ArtifactLinkResponse {
  url?: string;
  link?: string;
}

export async function openArtifactInBrowser(attachment: AttachmentReference): Promise<void> {
  const objectId = mediaIdFromUrl(attachment.url);
  if (!objectId) throw new Error('attachment is not a monolith media URL');
  const base = getBuzzRuntimeConfig().monolithUrl;
  const response = await monolithSession.fetch(`${base}/v1/media/${objectId}/link`, {}, { timeoutMs: 10_000 });
  if (!response.ok) throw new Error(`artifact link failed: ${response.status}`);
  const body = (await response.json()) as ArtifactLinkResponse;
  const url = body.url ?? body.link;
  if (!url) throw new Error('artifact link response carried no URL');
  await openExternalUrl(url);
}

/** Lands the PDF bytes in a cache file so an iOS preview can render page one locally. */
export async function artifactPdfLocalUri(attachment: AttachmentReference): Promise<string> {
  const objectId = mediaIdFromUrl(attachment.url) ?? 'artifact';
  if (!cacheDirectory) throw new Error('No cache directory is available for PDF previews.');
  const path = `${cacheDirectory}artifact-pdf-${objectId.replace(/[^0-9a-zA-Z-]/g, '')}.pdf`;
  const bytes = await fetchArtifactBytes(attachment);
  await writeAsStringAsync(path, toBase64(bytes), { encoding: EncodingType.Base64 });
  return `file://${path}`;
}

function toBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += chars[a >> 2];
    output += chars[((a & 3) << 4) | ((b ?? 0) >> 4)];
    output += b === undefined ? '=' : chars[((b & 15) << 2) | ((c ?? 0) >> 6)];
    output += c === undefined ? '=' : chars[c & 63];
  }
  return output;
}

/** Opens the signed link and folds every failure into one spoken outcome. */
export async function openArtifactInBrowserOrExplain(attachment: AttachmentReference): Promise<void> {
  try {
    await openArtifactInBrowser(attachment);
  } catch {
    Modal.alert('Could not open in browser', 'The signed link could not be minted. Try again.');
  }
}
