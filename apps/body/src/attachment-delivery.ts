/**
 * Attachments a person shares in a Room arrive at the harness as content, never
 * as a URL the harness must fetch: a Codex session runs inside Codex's own OS
 * sandbox with `networkAccess: false`, so any curl/fetch it attempts is denied
 * and the agent reports "downloads were blocked". The daemon (outside that
 * sandbox) downloads each file into the session's own scratch directory — the
 * `TMPDIR` overlay `agent-home.ts` gives every session and `bwrap-sandbox.ts`
 * mounts writable — and names the LOCAL PATH in the prompt. Images additionally
 * ride along as ACP `image` blocks when the harness advertises
 * `promptCapabilities.image`. The capability URL stays as a trailing reference
 * for harnesses that keep network.
 *
 * An image that cannot ride inline is never silently reduced to a path (C87).
 * There are exactly two reasons it cannot — the harness does not advertise
 * `promptCapabilities.image`, or the file is past `MAX_INLINE_IMAGE_BYTES` —
 * and both are named in the prompt so the agent says so in one plain sentence
 * in the SAME turn instead of inventing a description or waiting on a picture
 * that is not coming.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { DaemonAttachment } from '@beeline/api-contract/daemon';
import type { AcpPromptBlock } from './acp.js';

/** Same ceiling as the server media store and attach_file (`read-only-mcp.ts`). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** One download may not wedge a turn; a slow media read degrades to the URL line. */
const FETCH_TIMEOUT_MS = 30_000;
/**
 * The ceiling on ONE inline image. An inline block is base64 on a single
 * JSON-RPC line to the harness AND stays in that session's conversation
 * history, re-sent upstream on every later turn, so the 25 MB store ceiling is
 * the wrong bound here: a phone photo fits under this one, a raw scan does
 * not. Past it the file is still downloaded and named — only the inline copy
 * is refused, with a reason.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

export interface DeliveredAttachment {
  readonly attachment: DaemonAttachment;
  /** Local copy the harness can read; absent when the download was skipped or failed. */
  readonly path?: string;
  /** Why there is no local copy. */
  readonly reason?: string;
  /** Inline image payload for a multimodal harness; only for `image/*` local copies. */
  readonly image?: { data: string; mimeType: string };
  /**
   * Set when the local copy IS an image but deliberately does not ride inline
   * — a fact about the file, so it survives `withoutImageData` and reads the
   * same on a later transcript render.
   */
  readonly inlineSkipped?: string;
}

function safeFileName(attachment: DaemonAttachment, index: number, taken: Set<string>): string {
  const raw = basename(attachment.name ?? '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '');
  let name = raw || `attachment-${index + 1}`;
  if (taken.has(name)) {
    const ext = extname(name);
    name = `${name.slice(0, name.length - ext.length)}-${index + 1}${ext}`;
  }
  taken.add(name);
  return name;
}

/**
 * Download every attachment of one message into `dir`. Never throws: a skipped
 * or failed download degrades to a URL-only prompt line for that file.
 */
export async function deliverAttachments(
  attachments: readonly DaemonAttachment[],
  dir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveredAttachment[]> {
  if (!attachments.length) return [];
  const taken = new Set<string>();
  await mkdir(dir, { recursive: true });
  return Promise.all(
    attachments.map(async (attachment, index): Promise<DeliveredAttachment> => {
      const tooLarge = (bytes: number) => ({
        attachment,
        reason: `skipped: ${bytes} bytes exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit`,
      });
      if (attachment.size && attachment.size > MAX_ATTACHMENT_BYTES)
        return tooLarge(attachment.size);
      try {
        const response = await fetchImpl(attachment.url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > MAX_ATTACHMENT_BYTES) return tooLarge(declared);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_ATTACHMENT_BYTES) return tooLarge(bytes.length);
        const path = join(dir, safeFileName(attachment, index, taken));
        await writeFile(path, bytes);
        const mimeType = attachment.mimeType ?? response.headers.get('content-type') ?? '';
        if (!mimeType.startsWith('image/')) return { attachment, path };
        if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
          return {
            attachment,
            path,
            inlineSkipped: `${bytes.length} bytes is past the ${MAX_INLINE_IMAGE_BYTES}-byte inline image limit`,
          };
        }
        return { attachment, path, image: { data: bytes.toString('base64'), mimeType } };
      } catch (error) {
        return {
          attachment,
          reason: `download failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );
}

/** Drop the inline image bytes once the prompt is built, so a transcript cache stays small. */
export function withoutImageData(delivered: readonly DeliveredAttachment[]): DeliveredAttachment[] {
  return delivered.map(({ image: _image, ...rest }) => rest);
}

/**
 * Why an image attachment that HAS a local copy still does not reach the model
 * as image content, or `undefined` when it does.
 */
function unseenImageReason(
  attachment: DaemonAttachment,
  entry: DeliveredAttachment | undefined,
  harnessAcceptsImages: boolean,
): string | undefined {
  const isImage =
    attachment.mimeType?.startsWith('image/') || Boolean(entry?.image) || Boolean(entry?.inlineSkipped);
  if (!isImage || !entry?.path) return undefined;
  if (entry.inlineSkipped) return entry.inlineSkipped;
  if (!harnessAcceptsImages) return 'this session cannot take image content';
  return undefined;
}

/**
 * The prompt lines for one message's attachments. `harnessAcceptsImages` is
 * the live `promptCapabilities.image` answer: with it false, an image is named
 * as unseen rather than left to look like a picture the model was shown.
 */
export function attachmentPromptLines(
  attachments: readonly DaemonAttachment[],
  delivered?: readonly DeliveredAttachment[],
  harnessAcceptsImages = true,
): string[] {
  if (!attachments.length) return [];
  const byUrl = new Map(delivered?.map((entry) => [entry.attachment.url, entry]) ?? []);
  const unseen = new Set<string>();
  const lines = attachments.map((attachment) => {
    const kind = attachment.mimeType?.startsWith('image/') ? 'image' : 'file';
    const metadata = [attachment.mimeType, attachment.size ? `${attachment.size} bytes` : '']
      .filter(Boolean)
      .join(', ');
    const entry = byUrl.get(attachment.url);
    const location = entry?.path
      ? `local file ${entry.path}`
      : (entry?.reason ?? 'no local copy in this session');
    const reason = unseenImageReason(attachment, entry, harnessAcceptsImages);
    if (reason) unseen.add(reason);
    return `- ${kind}: ${attachment.name ?? 'attachment'}${metadata ? ` (${metadata})` : ''}: ${location}${
      reason ? ` (NOT shown to you as an image: ${reason})` : ''
    } (source ${attachment.url})`;
  });
  return [
    'Attachments shared with this message (read the local file; the trailing URL is only a reference, do not download it):',
    ...lines,
    ...(unseen.size
      ? [
          `You were not shown the picture itself: ${[...unseen].join('; ')}. If you are asked about it, say that in one plain sentence rather than describing an image you cannot see.`,
        ]
      : []),
  ];
}

/** Inline image blocks for the harness, only when it advertised `promptCapabilities.image`. */
export function attachmentImageBlocks(
  delivered: readonly DeliveredAttachment[],
  harnessAcceptsImages: boolean,
): AcpPromptBlock[] {
  if (!harnessAcceptsImages) return [];
  return delivered.flatMap((entry) =>
    entry.image
      ? [{ type: 'image' as const, data: entry.image.data, mimeType: entry.image.mimeType }]
      : [],
  );
}

/** A text prompt plus its inline image blocks, or the bare string when there are none. */
export function promptWithImages(
  text: string,
  images: readonly AcpPromptBlock[],
): string | AcpPromptBlock[] {
  return images.length ? [{ type: 'text', text }, ...images] : text;
}
