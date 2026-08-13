import type { NostrEvent } from '@beeline/nostr';

export const ATTACHMENT_MARKER = 'buzz-attachment';
export const ATTACHMENT_METADATA_TAG = 'imeta';
export const ATTACHMENT_FILENAME_TAG = 'attachment';

export interface AttachmentReference {
  url: string;
  name: string;
  mimeType: string;
  size: number;
  sha256?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

const MAX_ATTACHMENT_NAME_LENGTH = 255;
const MAX_ATTACHMENT_SIZE = 1024 * 1024 * 1024;

function httpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function cleanName(value: string): string | undefined {
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name && name.length <= MAX_ATTACHMENT_NAME_LENGTH ? name : undefined;
}

function cleanMimeType(value: string): string | undefined {
  const mimeType = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)
    ? mimeType
    : undefined;
}

function cleanSize(value: string | number): number | undefined {
  const size = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(size) && size >= 0 && size <= MAX_ATTACHMENT_SIZE ? size : undefined;
}

/** Validate metadata before it is signed into chat or exposed to a renderer. */
export function normalizeAttachmentReference(
  value: AttachmentReference,
): AttachmentReference | null {
  const url = httpUrl(value.url);
  const name = cleanName(value.name);
  const mimeType = cleanMimeType(value.mimeType);
  const size = cleanSize(value.size);
  if (!url || !name || !mimeType || size === undefined) return null;
  const thumbnailUrl = value.thumbnailUrl ? httpUrl(value.thumbnailUrl) : undefined;
  const sha256 = value.sha256?.toLowerCase();
  const width = cleanSize(value.width ?? 0);
  const height = cleanSize(value.height ?? 0);
  return {
    url,
    name,
    mimeType,
    size,
    ...(sha256 && /^[0-9a-f]{64}$/.test(sha256) ? { sha256 } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(value.width !== undefined && width !== undefined && width > 0 ? { width } : {}),
    ...(value.height !== undefined && height !== undefined && height > 0 ? { height } : {}),
  };
}

/** NIP-92-shaped metadata tag. It contains links and small metadata only, never bytes. */
export function buildAttachmentTag(reference: AttachmentReference): string[] {
  const attachment = normalizeAttachmentReference(reference);
  if (!attachment) throw new Error('invalid attachment reference');
  return [
    ATTACHMENT_METADATA_TAG,
    `url ${attachment.url}`,
    `m ${attachment.mimeType}`,
    `size ${attachment.size}`,
    ...(attachment.sha256 ? [`x ${attachment.sha256}`] : []),
    ...(attachment.thumbnailUrl ? [`thumb ${attachment.thumbnailUrl}`] : []),
    ...(attachment.width && attachment.height
      ? [`dim ${attachment.width}x${attachment.height}`]
      : []),
  ];
}

export function buildAttachmentTags(references: readonly AttachmentReference[]): string[][] {
  if (references.length === 0) return [];
  return [
    ['t', ATTACHMENT_MARKER],
    ...references.flatMap((reference) => {
      const attachment = normalizeAttachmentReference(reference);
      if (!attachment) throw new Error('invalid attachment reference');
      return [
        buildAttachmentTag(attachment),
        [ATTACHMENT_FILENAME_TAG, attachment.url, attachment.name],
      ];
    }),
  ];
}

function imetaFields(tag: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const entry of tag.slice(1)) {
    const splitAt = entry.indexOf(' ');
    if (splitAt <= 0) continue;
    fields.set(entry.slice(0, splitAt), entry.slice(splitAt + 1));
  }
  return fields;
}

/** Parse only complete, safe link metadata. Malformed tags never reach the UI or agent prompt. */
export function parseAttachmentTags(tags: readonly string[][]): AttachmentReference[] {
  if (!tags.some((tag) => tag[0] === 't' && tag[1] === ATTACHMENT_MARKER)) return [];
  const names = new Map(
    tags
      .filter(
        (tag) =>
          tag[0] === ATTACHMENT_FILENAME_TAG &&
          typeof tag[1] === 'string' &&
          typeof tag[2] === 'string',
      )
      .map((tag) => [tag[1]!, tag[2]!]),
  );
  return tags.flatMap((tag) => {
    if (tag[0] !== ATTACHMENT_METADATA_TAG) return [];
    const fields = imetaFields(tag);
    const dim = fields.get('dim')?.match(/^(\d+)x(\d+)$/);
    const normalized = normalizeAttachmentReference({
      url: fields.get('url') ?? '',
      name: names.get(fields.get('url') ?? '') ?? '',
      mimeType: fields.get('m') ?? '',
      size: Number(fields.get('size')),
      ...(fields.get('x') ? { sha256: fields.get('x') } : {}),
      ...(fields.get('thumb') ? { thumbnailUrl: fields.get('thumb') } : {}),
      ...(dim ? { width: Number(dim[1]), height: Number(dim[2]) } : {}),
    });
    return normalized ? [normalized] : [];
  });
}

export function eventAttachments(event: Pick<NostrEvent, 'tags'>): AttachmentReference[] {
  return parseAttachmentTags(event.tags);
}
