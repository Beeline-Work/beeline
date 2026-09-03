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
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { DaemonAttachment } from '@beeline/api-contract/daemon';
import type { AcpPromptBlock } from './acp.js';

/** Same ceiling as the server media store and attach_file (`read-only-mcp.ts`). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** One download may not wedge a turn; a slow media read degrades to the URL line. */
const FETCH_TIMEOUT_MS = 30_000;

export interface DeliveredAttachment {
  readonly attachment: DaemonAttachment;
  /** Local copy the harness can read; absent when the download was skipped or failed. */
  readonly path?: string;
  /** Why there is no local copy. */
  readonly reason?: string;
  /** Inline image payload for a multimodal harness; only for `image/*` local copies. */
  readonly image?: { data: string; mimeType: string };
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
        return {
          attachment,
          path,
          ...(mimeType.startsWith('image/')
            ? { image: { data: bytes.toString('base64'), mimeType } }
            : {}),
        };
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

/** The prompt lines for one message's attachments. */
export function attachmentPromptLines(
  attachments: readonly DaemonAttachment[],
  delivered?: readonly DeliveredAttachment[],
): string[] {
  if (!attachments.length) return [];
  const byUrl = new Map(delivered?.map((entry) => [entry.attachment.url, entry]) ?? []);
  return [
    'Attachments shared with this message (read the local file; the trailing URL is only a reference, do not download it):',
    ...attachments.map((attachment) => {
      const kind = attachment.mimeType?.startsWith('image/') ? 'image' : 'file';
      const metadata = [attachment.mimeType, attachment.size ? `${attachment.size} bytes` : '']
        .filter(Boolean)
        .join(', ');
      const entry = byUrl.get(attachment.url);
      const location = entry?.path
        ? `local file ${entry.path}`
        : (entry?.reason ?? 'no local copy in this session');
      return `- ${kind}: ${attachment.name ?? 'attachment'}${metadata ? ` (${metadata})` : ''}: ${location} (source ${attachment.url})`;
    }),
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
