import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { writeAsStringAsync, EncodingType, cacheDirectory } from 'expo-file-system/legacy';
import type { ClipboardImage } from 'expo-clipboard';
import type { BuzzClient, AttachmentReference } from '@beeline/buzz-client';
import { canonicalizeJpeg, canonicalizePng } from '@/buzz/avatar-png';
import { RawPhotoDecodeError } from '@/buzz/publish-failure';
import { readFileBytes } from '@/utils/readFileBytes';

export const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 10;
const THUMBNAIL_EDGE = 360;
const PHOTO_JPEG_QUALITY = 0.9;
type PreservedPhotoFormat = 'jpeg' | 'png' | 'gif' | 'webp';
const PRESERVED_PHOTO_EXTENSIONS: Readonly<Record<string, PreservedPhotoFormat>> = {
  gif: 'gif',
  jpeg: 'jpeg',
  jpg: 'jpeg',
  png: 'png',
  webp: 'webp',
};
const PRESERVED_PHOTO_MIME_TYPES: Readonly<Record<string, PreservedPhotoFormat>> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const RAW_PHOTO_EXTENSIONS = new Set([
  '3fr',
  'arw',
  'cr2',
  'cr3',
  'crw',
  'dng',
  'erf',
  'iiq',
  'kdc',
  'mef',
  'mos',
  'mrw',
  'nef',
  'nrw',
  'orf',
  'pef',
  'raf',
  'raw',
  'rwl',
  'rw2',
  'sr2',
  'srw',
  'x3f',
]);
const RAW_PHOTO_MIME_TYPES = new Set([
  'image/dng',
  'image/x-adobe-dng',
  'image/x-canon-cr2',
  'image/x-canon-cr3',
  'image/x-fuji-raf',
  'image/x-nikon-nef',
  'image/x-olympus-orf',
  'image/x-panasonic-rw2',
  'image/x-pentax-pef',
  'image/x-raw',
  'image/x-sony-arw',
]);

export type PickedChatAttachment = {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  source: 'photo' | 'file';
  width?: number;
  height?: number;
};

type PickedPhotoAsset = {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number;
  width: number;
  height: number;
};

/** Preserves the picker order and gives unnamed assets stable, distinct labels. */
export function pickedPhotoAttachments(
  assets: readonly PickedPhotoAsset[],
  pickedAt = Date.now(),
): PickedChatAttachment[] {
  return assets.map((asset, index) => ({
    uri: asset.uri,
    name: asset.fileName?.trim() || `photo-${pickedAt}-${index + 1}.jpg`,
    mimeType: asset.mimeType ?? 'image/jpeg',
    size: asset.fileSize ?? 0,
    source: 'photo',
    width: asset.width,
    height: asset.height,
  }));
}

const CLIPBOARD_IMAGE_DATA_URI = /^data:(image\/\w+);base64,(.+)$/;

/** Spills expo-clipboard's base64 image data to a cache file so a paste flows through the same upload pipeline as a picked photo. */
export async function pastedImageAttachment(
  image: ClipboardImage,
  pastedAt = Date.now(),
): Promise<PickedChatAttachment> {
  const match = CLIPBOARD_IMAGE_DATA_URI.exec(image.data);
  if (!match) throw new Error('Clipboard image data was not readable.');
  const [, mimeType, base64] = match;
  if (!cacheDirectory)
    throw new Error('No cache directory is available to store the pasted image.');
  const name = `pasted-${pastedAt}.${mimeType.split('/')[1] ?? 'png'}`;
  const uri = `${cacheDirectory}${name}`;
  await writeAsStringAsync(uri, base64, { encoding: EncodingType.Base64 });
  return {
    uri,
    name,
    mimeType,
    size: Math.ceil((base64.length * 3) / 4),
    source: 'photo',
    width: image.size.width,
    height: image.size.height,
  };
}

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
  const mimeType = attachment.mimeType.toLowerCase();
  const extension = attachment.name.split('.').pop()?.toLowerCase();
  const raw = RAW_PHOTO_MIME_TYPES.has(mimeType) || RAW_PHOTO_EXTENSIONS.has(extension ?? '');
  const preservedFormat =
    PRESERVED_PHOTO_MIME_TYPES[mimeType] ??
    (mimeType.startsWith('image/')
      ? undefined
      : extension
        ? PRESERVED_PHOTO_EXTENSIONS[extension]
        : undefined);
  if (!raw && preservedFormat) {
    const bytes = await readFileBytes(attachment.uri);
    return {
      bytes:
        preservedFormat === 'jpeg'
          ? canonicalizeJpeg(bytes)
          : preservedFormat === 'png'
            ? canonicalizePng(bytes)
            : bytes,
      mimeType:
        preservedFormat === 'jpeg'
          ? 'image/jpeg'
          : preservedFormat === 'png'
            ? 'image/png'
            : preservedFormat === 'gif'
              ? 'image/gif'
              : 'image/webp',
      name: attachment.name,
    };
  }
  let encoded: Awaited<ReturnType<typeof manipulateAsync>>;
  try {
    encoded = await manipulateAsync(attachment.uri, [], {
      compress: PHOTO_JPEG_QUALITY,
      format: SaveFormat.JPEG,
    });
  } catch (error) {
    if (raw) throw new RawPhotoDecodeError(error);
    throw error;
  }
  const bytes = await readFileBytes(encoded.uri);
  return {
    bytes: canonicalizeJpeg(bytes),
    mimeType: 'image/jpeg',
    name: replaceExtension(attachment.name, 'jpg'),
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
  const prepared =
    attachment.source === 'photo'
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

/**
 * Starts each staged attachment's upload the moment it lands in the composer,
 * so send only waits for whatever is still in flight. Uploads run one at a time
 * in the order they were added, so a ten-photo pick never holds ten full
 * photos in memory. A failed upload is forgotten and retried by `uploadAll`,
 * including one that fails while send is waiting on it; a removed attachment
 * that has not started yet is skipped.
 */
export function createChatAttachmentUploader() {
  const uploads = new Map<PickedChatAttachment, Promise<AttachmentReference>>();
  let queue: Promise<unknown> = Promise.resolve();
  const start = (client: BuzzClient, attachment: PickedChatAttachment) => {
    const existing = uploads.get(attachment);
    if (existing) return existing;
    const upload: Promise<AttachmentReference> = queue.then(() => {
      if (uploads.get(attachment) !== upload) throw new Error('The attachment was removed.');
      return uploadChatAttachment(client, attachment);
    });
    uploads.set(attachment, upload);
    queue = upload.catch(() => {
      if (uploads.get(attachment) === upload) uploads.delete(attachment);
    });
    return upload;
  };
  return {
    /** Begins uploading every attachment not already uploading or uploaded. */
    start(client: BuzzClient, attachments: readonly PickedChatAttachment[]) {
      for (const attachment of attachments) void start(client, attachment).catch(() => undefined);
    },
    /** Drops every attachment no longer staged in the composer. */
    retain(attachments: readonly PickedChatAttachment[]) {
      for (const attachment of uploads.keys())
        if (!attachments.includes(attachment)) uploads.delete(attachment);
    },
    /**
     * One message's uploaded references, in display order. An upload that was
     * already running when send began gets one fresh attempt if it fails.
     */
    uploadAll(
      client: BuzzClient,
      attachments: readonly PickedChatAttachment[],
    ): Promise<AttachmentReference[]> {
      return Promise.all(
        attachments.map((attachment) => {
          const staged = uploads.has(attachment);
          const upload = start(client, attachment);
          return staged ? upload.catch(() => start(client, attachment)) : upload;
        }),
      );
    },
  };
}
