import type { SessionEvent } from '@/sync/transport';
import { sessionEventHasTag, sessionEventPayload } from '@/sync/transport/buzz-event-projection';
import { isRetiredAgentStateNotice } from './retired-agent-notices';

const CONTROL_TEXT = /^Agent opened(?: #| a work branch for:)/;

/** Preview length that fills one line on the narrowest shipped phone without
 * the trailing ellipsis landing mid-word on every row. */
const PREVIEW_MAX_CHARS = 120;

/**
 * Lines that are machine plumbing and must never reach a person-facing
 * preview. These mirror the shapes `summarizeGitFailure`
 * (`packages/buzz-client/src/git-failure.ts`) recognizes at publish time; this
 * is the reader-side floor for anything that predates that fix, arrives from a
 * tool it does not cover, or was pasted into a Room by a person.
 */
const PLUMBING_LINE: RegExp[] = [
  /^(?:hint|error|fatal|warning|remote|usage|stderr|stdout):/i,
  /^!\s*\[/,
  /^\*\s*\[new (?:branch|tag)\]/i,
  /^(?:to|from)\s+(?:https?:\/\/|git@|ssh:\/\/)/i,
  /^diff --git\b/,
  /^index [0-9a-f]{7,}\.\.[0-9a-f]{7,}/i,
  /^@@ /,
  /^[+-]{3} [ab]?\//,
  /^\s*at .+\(.+:\d+:\d+\)$/,
  /^\$ /,
  /^everything up-to-date$/i,
  /^branch '.+' set up to track\b/i,
  // `git push` ref-status lines: the leading bracket form (`* [new branch]`,
  // `! [rejected]`, `[up to date]`) and the bare range form
  // (`abc1234..def5678  main -> main`, `+ abc1234...def5678  main -> main`).
  /^[-*+=!]?\s*\[(?:new branch|new tag|deleted|rejected|remote rejected|up to date)\]/i,
  /^[+-]?\s*[0-9a-f]{7,}\.{2,3}[0-9a-f]{7,}\b/i,
];

/** A divider or setext underline carries no words. */
const RULE_LINE = /^[-=_*~]{3,}$/;

/**
 * A lone machine token: a ref path (`remote/1a2b3c4`, `refs/heads/main`,
 * `origin/main`), a bare object id, or any slash-joined path ending in one.
 *
 * These are the shapes that survive every line-level filter above, because a
 * ref pointer is a perfectly well-formed "sentence" of one word — and
 * `shortenShas` made it *worse*, turning a recognizably machine-shaped 40-hex
 * blob into a plausible-looking `remote/1a2b3c4`. The index is a place to
 * scan, not a terminal: a preview built only from tokens like these has
 * nothing a person can read, so it is suppressed outright and the row keeps
 * the last message that did.
 */
const MACHINE_TOKEN =
  /^(?:[0-9a-f]{7,}\.{2,3}[0-9a-f]{7,}|[0-9a-f]{7,}|(?:remote|origin|upstream|refs|heads|tags)\/\S*|\S*\/[0-9a-f]{7,}|->)$/i;

/** A bare object id is hex *and* carries a digit, so an ordinary word that
 * happens to spell out of `a`–`f` ("defaced") is never mistaken for one. */
const OBJECT_ID = /\d/;

/**
 * True when nothing in the text is a word a person would read — every token is
 * a ref, a pointer, or an object id.
 *
 * Exported because it is also the *reader*-side floor: a preview stored by an
 * older build of this file is already in the local cache, and the index must
 * not print it while waiting for a revalidation to replace it. Checking is not
 * re-deriving — a row still never rewrites message text, it only declines to
 * show one that says nothing.
 */
export function isMachinePreview(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.every((token) => token === '->')) return false;
  return tokens.every(
    (token) =>
      MACHINE_TOKEN.test(token) && (token.includes('/') || token === '->' || OBJECT_ID.test(token)),
  );
}

export type RoomMessageSummary = {
  id: string;
  text: string;
  timestamp: number;
  authorPubkey?: string;
};

function shortenShas(text: string): string {
  return text.replace(/\b[0-9a-f]{40}\b/gi, (sha) => sha.slice(0, 7));
}

/** Flatten one line of markdown into the plain words it renders as. */
function flattenMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*{1,2}/g, '')
    .replace(/(?:https?:\/\/)([^\s/]+)\S*/gi, '$1')
    .trim();
}

/**
 * The one-line, human-readable form of a Room's latest message. Fenced code,
 * markdown syntax, git/tool plumbing, and bare commit ids never reach the
 * index — a Room row is a place to scan, not a terminal. Returns `''` when a
 * message contains nothing a person would want to read, which the caller
 * treats as "not a preview" so the previous readable message keeps the row.
 */
export function roomPreviewText(raw: string, limit = PREVIEW_MAX_CHARS): string {
  const withoutCode = raw.replace(/```[\s\S]*?```/g, ' ').replace(/```[\s\S]*$/, ' ');
  const readable = withoutCode
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !RULE_LINE.test(line))
    .filter((line) => !PLUMBING_LINE.some((pattern) => pattern.test(line)))
    .map(flattenMarkdown)
    .filter((line) => line.length > 0)
    .join(' ');
  const collapsed = shortenShas(readable).replace(/\s+/g, ' ').trim();
  if (!collapsed || isMachinePreview(collapsed)) return '';
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1).trimEnd()}…` : collapsed;
}

/**
 * Uppercase mono attribution for an index preview line — the same "who said
 * this" label the transcript rows carry, so a Room row and the Room it opens
 * read as one system.
 *
 * An author outside the current Workspace roster resolves to no name, and the
 * caller renders the preview unattributed: a shouty truncated npub is worse
 * than no label, and it is the one case where the index has nothing true to
 * say about who spoke.
 */
export function previewAuthorLabel(name: string | undefined, maxChars = 12): string {
  const upper = name?.trim().toUpperCase();
  if (!upper) return '';
  return upper.length > maxChars ? `${upper.slice(0, maxChars - 1)}…` : upper;
}

function roomMessage(event: SessionEvent): RoomMessageSummary | null {
  const payload = sessionEventPayload(event);
  if (!payload || typeof payload.content !== 'string') return null;
  if (sessionEventHasTag(event, 't', 'body-control') || sessionEventHasTag(event, 'subchannel')) {
    return null;
  }

  const text = payload.content.trim();
  if (!text || CONTROL_TEXT.test(text)) return null;
  // A retired daemon state notice still sitting in relay history. It reads as
  // an ordinary agent message, so without this an index row would keep
  // advertising a reconnect from months ago as the Room's latest word.
  if (isRetiredAgentStateNotice(text)) return null;
  const preview = roomPreviewText(text);
  if (!preview) return null;
  return {
    id: typeof payload.id === 'string' ? payload.id : '',
    text: preview,
    timestamp: typeof payload.createdAt === 'number' ? payload.createdAt : 0,
    ...(typeof payload.pubkey === 'string' ? { authorPubkey: payload.pubkey } : {}),
  };
}

/** Latest person-facing Room message, excluding Corner control and activity events. */
export function latestRoomMessageSummary(events: SessionEvent[]): RoomMessageSummary | null {
  const messages = events
    .map(roomMessage)
    .filter((message): message is RoomMessageSummary => Boolean(message))
    .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
  return messages[0] ?? null;
}

export function latestRoomMessage(events: SessionEvent[]): string | null {
  return latestRoomMessageSummary(events)?.text ?? null;
}
