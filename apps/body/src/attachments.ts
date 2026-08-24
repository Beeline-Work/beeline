import { extname } from 'node:path';
import type { AttachmentReference } from '@beeline/buzz-client';
import type { PromptResult, SessionUpdate } from './acp.js';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const JPEG_SIGNATURE = new Uint8Array([0xff, 0xd8]);

function readPngChunkLength(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function pngChunkName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset + 4]!,
    bytes[offset + 5]!,
    bytes[offset + 6]!,
    bytes[offset + 7]!,
  );
}

/**
 * Relay media storage accepts canonical PNG containers only. Agent encoders
 * (matplotlib, Pillow, Codex image generation) routinely emit ancillary color,
 * time, text, and EXIF chunks even though nothing consumes them. Keep the
 * lossless image chunks and drop every metadata channel.
 */
export function canonicalizePng(bytes: Uint8Array): Uint8Array {
  if (
    bytes.byteLength < PNG_SIGNATURE.byteLength ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    throw new Error('Image conversion did not produce a valid PNG image.');
  }

  const chunks: Uint8Array[] = [bytes.slice(0, PNG_SIGNATURE.byteLength)];
  let offset = PNG_SIGNATURE.byteLength;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = readPngChunkLength(bytes, offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) {
      throw new Error('Image conversion produced a malformed PNG image.');
    }
    const name = pngChunkName(bytes, offset);
    if (name === 'IHDR') sawHeader = true;
    if (name === 'IDAT') sawImageData = true;
    if (name === 'IEND') sawEnd = true;
    if (PNG_CRITICAL_CHUNKS.has(name)) chunks.push(bytes.slice(offset, end));
    offset = end;
    if (name === 'IEND') break;
  }
  if (!sawHeader || !sawImageData || !sawEnd) {
    throw new Error('Image conversion produced an incomplete PNG image.');
  }

  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const canonical = new Uint8Array(byteLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    canonical.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return canonical;
}

/**
 * Keep JPEG rendering data while removing every descriptive metadata channel.
 * APP0-APP15 and COM markers can carry EXIF, XMP, ICC, Photoshop records,
 * comments, or thumbnails; a freshly encoded image needs none of them.
 */
export function canonicalizeJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 2 || bytes[0] !== JPEG_SIGNATURE[0] || bytes[1] !== JPEG_SIGNATURE[1]) {
    throw new Error('Image conversion did not produce a valid JPEG image.');
  }

  const parts: Uint8Array[] = [bytes.slice(0, 2)];
  let offset = 2;
  let inScan = false;
  let sawEnd = false;
  while (offset < bytes.byteLength) {
    if (inScan && bytes[offset] !== 0xff) {
      const start = offset;
      while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
      parts.push(bytes.slice(start, offset));
      continue;
    }
    if (bytes[offset] !== 0xff) {
      throw new Error('Image conversion produced a malformed JPEG image.');
    }

    const markerStart = offset;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) {
      throw new Error('Image conversion produced a malformed JPEG image.');
    }
    const marker = bytes[offset]!;
    offset += 1;

    if (inScan && marker === 0x00) {
      parts.push(bytes.slice(markerStart, offset));
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(bytes.slice(markerStart, offset));
      continue;
    }
    if (marker === 0xd9) {
      if (offset !== bytes.byteLength) {
        throw new Error('Image conversion produced a malformed JPEG image.');
      }
      parts.push(bytes.slice(markerStart, offset));
      sawEnd = true;
      break;
    }
    if (marker === 0xd8 || offset + 2 > bytes.byteLength) {
      throw new Error('Image conversion produced a malformed JPEG image.');
    }

    const length = bytes[offset]! * 0x100 + bytes[offset + 1]!;
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > bytes.byteLength) {
      throw new Error('Image conversion produced a malformed JPEG image.');
    }

    // Remove the whole APPn/COM metadata class fail-closed — the same policy
    // the mobile client applies to human-sent attachments.
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!metadata) parts.push(bytes.slice(markerStart, segmentEnd));
    offset = segmentEnd;
    inScan = marker === 0xda;
  }

  if (!sawEnd) throw new Error('Image conversion produced an incomplete JPEG image.');

  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const canonical = new Uint8Array(byteLength);
  let writeOffset = 0;
  for (const part of parts) {
    canonical.set(part, writeOffset);
    writeOffset += part.byteLength;
  }
  return canonical;
}

/**
 * The relay's media store rejects metadata-bearing image containers with HTTP
 * 422 "media contains metadata or a non-canonical metadata channel". Human-
 * sent attachments are normalized client-side before upload (see the mobile
 * app's chat-attachment path); agent-produced files arrive here raw from
 * whatever encoder wrote them, so strip every metadata channel at this layer.
 *
 * Format is taken from the declared MIME type, falling back to magic-byte
 * sniffing when the agent handed over an unrecognized extension. Returns the
 * input unchanged when the bytes do not parse as that container — the upload
 * then decides, exactly as it would have before this normalization existed.
 */
export function canonicalizeImageForUpload(bytes: Uint8Array, mimeType?: string): Uint8Array {
  const declared = mimeType ?? '';
  try {
    if (declared === 'image/png' || (!declared.startsWith('image/') && startsWith(bytes, PNG_SIGNATURE)))
      return canonicalizePng(bytes);
    if (
      declared === 'image/jpeg' ||
      (!declared.startsWith('image/') && startsWith(bytes, JPEG_SIGNATURE))
    )
      return canonicalizeJpeg(bytes);
  } catch {
    return bytes;
  }
  return bytes;
}

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  return (
    bytes.byteLength >= signature.byteLength &&
    signature.every((value, index) => bytes[index] === value)
  );
}

export const AGENT_ATTACHMENT_DIRECTIVE = 'buzz-attachment';
export const MAX_AGENT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_AGENT_ATTACHMENTS_PER_TURN = 8;

export interface AgentOutputCandidate {
  name: string;
  mimeType: string;
  path?: string;
  bytes?: Uint8Array;
}

export interface RoomAuthorAttribution {
  kind: 'Agent' | 'Person' | 'Member';
  name: string;
  handle: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function imageContent(value: unknown): Record<string, unknown> | undefined {
  const outer = objectValue(value);
  if (!outer) return undefined;
  const content = outer.type === 'content' ? objectValue(outer.content) : outer;
  return content?.type === 'image' ? content : undefined;
}

function contentItems(update: Record<string, unknown>): unknown[] {
  return Array.isArray(update.content) ? update.content : update.content ? [update.content] : [];
}

function generatedImageName(
  update: Record<string, unknown>,
  index: number,
  mimeType: string,
): string {
  const toolCallId =
    typeof update.toolCallId === 'string' ? update.toolCallId.replace(/[^a-zA-Z0-9_-]/g, '') : '';
  const extension =
    mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1]?.split('+')[0] || 'png';
  return `generated-image-${toolCallId || index + 1}.${extension}`;
}

/** Extract ACP image outputs without ever copying them into a Room message. */
export function generatedImageCandidates(
  updates: readonly SessionUpdate[],
): AgentOutputCandidate[] {
  const found: AgentOutputCandidate[] = [];
  const seen = new Set<string>();
  for (const { update } of updates) {
    for (const item of contentItems(update)) {
      const image = imageContent(item);
      if (!image) continue;
      const mimeType = typeof image.mimeType === 'string' ? image.mimeType : 'image/png';
      const uri = typeof image.uri === 'string' ? image.uri.replace(/^file:\/\//, '') : undefined;
      const data = typeof image.data === 'string' ? image.data : undefined;
      const key = uri ?? `${update.toolCallId ?? ''}:${data?.slice(0, 48) ?? found.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (uri) {
        found.push({
          name: uri.split('/').pop() || generatedImageName(update, found.length, mimeType),
          mimeType,
          path: uri,
          ...(data
            ? { bytes: Uint8Array.from(Buffer.from(data.replace(/^data:[^,]+,/, ''), 'base64')) }
            : {}),
        });
      } else if (data) {
        found.push({
          name: generatedImageName(update, found.length, mimeType),
          mimeType,
          bytes: Uint8Array.from(Buffer.from(data.replace(/^data:[^,]+,/, ''), 'base64')),
        });
      }
      if (found.length >= MAX_AGENT_ATTACHMENTS_PER_TURN) return found;
    }
  }
  return found;
}

/** Agents can share any worktree file using a tiny final-response directive. */
export function attachmentPathsFromText(text: string): string[] {
  const paths: string[] = [];
  const expression = new RegExp(`\\[\\[${AGENT_ATTACHMENT_DIRECTIVE}:([^\\]\\r\\n]+)\\]\\]`, 'g');
  for (const match of text.matchAll(expression)) {
    const path = match[1]?.trim();
    if (path && !paths.includes(path)) paths.push(path);
    if (paths.length >= MAX_AGENT_ATTACHMENTS_PER_TURN) break;
  }
  return paths;
}

export function stripAttachmentDirectives(text: string): string {
  return text
    .replace(/data:[^\s;,]+(?:;[^\s,]+)*;base64,[a-z0-9+/=]+/gi, '[inline binary omitted]')
    .replace(new RegExp(`\\s*\\[\\[${AGENT_ATTACHMENT_DIRECTIVE}:[^\\]\\r\\n]+\\]\\]\\s*`, 'g'), '\n')
    .trim();
}

export function mimeTypeForName(name: string): string {
  const extension = extname(name).toLowerCase();
  return (
    (
      {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'application/json',
        '.csv': 'text/csv',
        '.zip': 'application/zip',
      } as Record<string, string>
    )[extension] ?? 'application/octet-stream'
  );
}

export function attachmentPrompt(
  authorPubkey: string,
  content: string,
  attachments: readonly AttachmentReference[],
  author?: RoomAuthorAttribution,
): string {
  const message = content.trim() || '(shared attachments)';
  const attribution = author
    ? `${author.kind} ${author.name} (@${author.handle}) · ${authorPubkey.slice(0, 12)}`
    : `Member ${authorPubkey.slice(0, 12)}`;
  if (!attachments.length) return `[${attribution}]: ${message}`;
  return [
    `[${attribution}]: ${message}`,
    '',
    'Attachments (links and metadata only; fetch a URL only if the task requires the file):',
    ...attachments.map(
      (item) => `- ${item.name} (${item.mimeType}, ${item.size} bytes): ${item.url}`,
    ),
  ].join('\n');
}

/** Remove binary ACP fields before activity is serialized into a relay event. */
export function sanitizeActivityUpdate(update: Record<string, unknown>): Record<string, unknown> {
  const sanitize = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') {
      if (key === 'data' || value.startsWith('data:'))
        return `[binary omitted: ${value.length} chars]`;
      if ((key === 'result' || key === 'rawOutput') && value.length > 8_192)
        return `[large output omitted: ${value.length} chars]`;
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => sanitize(item));
    const object = objectValue(value);
    if (!object) return value;
    return Object.fromEntries(
      Object.entries(object).map(([entryKey, item]) => [entryKey, sanitize(item, entryKey)]),
    );
  };
  return sanitize(update) as Record<string, unknown>;
}

export function outputCandidates(result: PromptResult): AgentOutputCandidate[] {
  return [
    ...attachmentPathsFromText(result.agentText).map((path) => ({
      name: path.split('/').pop() || 'attachment',
      mimeType: mimeTypeForName(path),
      path,
    })),
    ...generatedImageCandidates(result.updates),
  ].slice(0, MAX_AGENT_ATTACHMENTS_PER_TURN);
}
