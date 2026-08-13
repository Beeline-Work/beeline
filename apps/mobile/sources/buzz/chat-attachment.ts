import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import type { BuzzClient, AttachmentReference } from '@beeline/buzz-client';
import { readFileBytes } from '@/utils/readFileBytes';

export const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const THUMBNAIL_EDGE = 360;

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
    const thumbnail = await client.uploadMedia(await readFileBytes(resized.uri), 'image/jpeg');
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
  const bytes = await readFileBytes(attachment.uri);
  if (!bytes.byteLength) throw new Error('The selected file is empty.');
  if (bytes.byteLength > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error('Files must be 25 MB or smaller.');
  }
  const [uploaded, generatedThumbnailUrl] = await Promise.all([
    client.uploadMedia(bytes, attachment.mimeType),
    uploadImageThumbnail(client, attachment),
  ]);
  return {
    url: uploaded.url,
    name: attachment.name,
    mimeType: uploaded.type ?? attachment.mimeType,
    size: uploaded.size,
    sha256: uploaded.sha256,
    ...(uploaded.thumb || generatedThumbnailUrl
      ? { thumbnailUrl: uploaded.thumb ?? generatedThumbnailUrl }
      : {}),
    ...(attachment.width ? { width: attachment.width } : {}),
    ...(attachment.height ? { height: attachment.height } : {}),
  };
}
