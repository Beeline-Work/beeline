import { extname } from 'node:path';
import type { AttachmentReference } from '@beeline/buzz-client';
import type { PromptResult, SessionUpdate } from './acp.js';

export const AGENT_ATTACHMENT_DIRECTIVE = 'buzz-attachment';
export const MAX_AGENT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_AGENT_ATTACHMENTS_PER_TURN = 8;

export interface AgentOutputCandidate {
  name: string;
  mimeType: string;
  path?: string;
  bytes?: Uint8Array;
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
  const expression = /\[\[buzz-attachment:([^\]\r\n]+)\]\]/g;
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
    .replace(/\s*\[\[buzz-attachment:[^\]\r\n]+\]\]\s*/g, '\n')
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
): string {
  const message = content.trim() || '(shared attachments)';
  if (!attachments.length) return `[Member ${authorPubkey.slice(0, 12)}]: ${message}`;
  return [
    `[Member ${authorPubkey.slice(0, 12)}]: ${message}`,
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
