import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import type { BuzzClient, AttachmentReference } from '@beeline/buzz-client';
import { canonicalizeJpeg, canonicalizePng } from '@/buzz/avatar-png';
import { readFileBytes } from '@/utils/readFileBytes';

export const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const THUMBNAIL_EDGE = 360;
const PHOTO_JPEG_QUALITY = 0.9;

export type PickedChatAttachment = {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
};

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

/** Active file cards use the isolated renderer; ordinary files keep their media URL. */
export function attachmentOpenUrl(attachment: AttachmentReference): string {
  return attachment.previewUrl ?? attachment.url;
}

function replaceExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`;
}

async function prepareImageForUpload(attachment: PickedChatAttachment): Promise<{
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}> {
  // Preserve lossless/alpha-bearing formats as PNG. Gallery photos use JPEG
  // so a full-resolution phone image remains comfortably below the media cap.
  const jpeg = attachment.mimeType === 'image/jpeg' || attachment.mimeType === 'image/jpg';
  const encoded = await manipulateAsync(attachment.uri, [], {
    compress: jpeg ? PHOTO_JPEG_QUALITY : 1,
    format: jpeg ? SaveFormat.JPEG : SaveFormat.PNG,
  });
  const bytes = await readFileBytes(encoded.uri);
  return jpeg
    ? {
        bytes: canonicalizeJpeg(bytes),
        mimeType: 'image/jpeg',
        name: replaceExtension(attachment.name, 'jpg'),
      }
    : {
        bytes: canonicalizePng(bytes),
        mimeType: 'image/png',
        name: replaceExtension(attachment.name, 'png'),
      };
}

async function uploadImageThumbnail(
  client: BuzzClient,
  attachment: PickedChatAttachment,
): Promise<string | undefined> {
  if (!attachment.mimeType.startsWith('image/')) return undefined;
  try {
    const landscape = (attachment.width ?? 0) >= (attachment.height ?? 0);
    const resized = await manipulateAsync(
      attachment.uri,
      [{ resize: landscape ? { width: THUMBNAIL_EDGE } : { height: THUMBNAIL_EDGE } }],
      { compress: 0.72, format: SaveFormat.JPEG },
    );
    const thumbnail = await client.uploadMedia(
      canonicalizeJpeg(await readFileBytes(resized.uri)),
      'image/jpeg',
    );
    return thumbnail.thumb ?? thumbnail.url;
  } catch {
    return undefined;
  }
}

/** Uploads bytes to Buzz media, then returns only a durable URL and bounded metadata. */
export async function uploadChatAttachment(
  client: BuzzClient,
  attachment: PickedChatAttachment,
): Promise<AttachmentReference> {
  const prepared = attachment.mimeType.startsWith('image/')
    ? await prepareImageForUpload(attachment)
    : {
        bytes: await readFileBytes(attachment.uri),
        mimeType: attachment.mimeType,
        name: attachment.name,
      };
  const { bytes } = prepared;
  if (!bytes.byteLength) throw new Error('The selected file is empty.');
  if (bytes.byteLength > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error('Files must be 25 MB or smaller.');
  }
  const [uploaded, generatedThumbnailUrl] = await Promise.all([
    client.uploadMedia(bytes, prepared.mimeType),
    uploadImageThumbnail(client, attachment),
  ]);
  return {
    url: uploaded.url,
    name: prepared.name,
    mimeType: uploaded.type ?? prepared.mimeType,
    size: uploaded.size,
    sha256: uploaded.sha256,
    ...(uploaded.thumb || generatedThumbnailUrl
      ? { thumbnailUrl: uploaded.thumb ?? generatedThumbnailUrl }
      : {}),
    ...(attachment.width ? { width: attachment.width } : {}),
    ...(attachment.height ? { height: attachment.height } : {}),
  };
}
