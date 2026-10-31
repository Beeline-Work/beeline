import {
  identityHandle,
  isConnectorIdentity,
  roomTitle,
} from '@beeline/api-contract/phone';
import type { RoomCornerSummary } from '@/buzz/room-corner-store';
import {
  type ChatListItem,
  type RoomViewIdentity,
} from '@beeline/buzz-client';

export type RoomListSection = {
  kind: 'rooms' | 'messages';
  title: 'Rooms' | 'Direct messages';
  data: ChatListItem[];
};

/** A Room row carries the corner mark only when the viewer's dropdown has corners. */
export function roomRowShowsCornerMark(
  item: Pick<ChatListItem, 'directMessage'>,
  summary: RoomCornerSummary | undefined,
): boolean {
  return !item.directMessage && Boolean(summary?.openCorners.some((corner) => corner.mine));
}

/** Rooms lead the index; direct messages follow in their own newest-first section. */
export function roomListSections(chats: readonly ChatListItem[], includeEmpty = false): RoomListSection[] {
  const visibleChats = chats.filter((item) => !item.closed);
  const rooms = visibleChats.filter((item) => !item.directMessage);
  const messages = visibleChats
    .filter((item) => Boolean(item.directMessage))
    .sort(
      (left, right) =>
        (right.latestMessage?.createdAt ?? right.room.updatedAt ?? 0) -
        (left.latestMessage?.createdAt ?? left.room.updatedAt ?? 0),
    );
  return [
    ...(rooms.length || includeEmpty ? [{ kind: 'rooms' as const, title: 'Rooms' as const, data: rooms }] : []),
    ...(messages.length || includeEmpty
      ? [{ kind: 'messages' as const, title: 'Direct messages' as const, data: messages }]
      : []),
  ];
}

export const NO_ACTIVITY_PREVIEW = 'No messages yet';

// ── The index row (Speakeasy findings, 2026-09-03) ───────────────────────────
//
// Every row-level fact the Room list paints — the sigil, the name, the tile
// identity, the preview attribution, and whether the attention square is lit —
// is derived here from the server-indexed `ChatListItem`, so the screen only
// renders answers. The three functions below are the whole contract.

/**
 * A row's leading glyph reports its KIND: `@` for a direct message, `#` for
 * a Room. Both draw in brass; the name that follows draws in the primary
 * tone. Corners keep `◇` (`vocabulary.ts`); Workspaces on the rail get none.
 */
export type RoomRowSigil = '@' | '#';

export type RoomRowName = {
  sigil: RoomRowSigil;
  /** The name WITHOUT its sigil — the row draws the two in different tones. */
  name: string;
};

export function roomRowName(item: Pick<ChatListItem, 'room' | 'directMessage'>): RoomRowName {
  const peer = item.directMessage?.peer;
  if (peer) {
    return {
      sigil: '@',
      name: identityHandle(peer),
    };
  }
  return { sigil: '#', name: roomTitle(item.room.name)?.slice(1) ?? item.room.id };
}

/**
 * The preview line's attribution. The viewer's own last message reads
 * `you: ` in the muted tone; anyone else's — a person or an agent alike —
 * reads `@handle: ` in brass; an empty Room reads `No messages yet` with no
 * attribution at all. The preview text itself always sits in the quiet tone.
 */
export type RoomRowPreview =
  | { attribution: 'none'; text: string }
  | { attribution: 'self'; text: string }
  | { attribution: 'other'; handle: string; text: string };

export function roomRowPreview(
  item: Pick<ChatListItem, 'latestMessage'> & Partial<Pick<ChatListItem, 'directMessage'>>,
  viewerPubkey: string | undefined,
): RoomRowPreview {
  const latest = item.latestMessage;
  const text = latest?.text.trim();
  if (!latest) return { attribution: 'none', text: NO_ACTIVITY_PREVIEW };
  const preview = text || attachmentPreview(latest.attachments);
  if (!preview) return { attribution: 'none', text: NO_ACTIVITY_PREVIEW };
  if (viewerPubkey && latest.author.pubkey === viewerPubkey)
    return { attribution: 'self', text: preview };
  // Older cached grant cards may still carry the asking agent as author.
  // The connector DM itself is the authority for the sender shown in the list.
  const peer = item.directMessage?.peer;
  const author = peer && isConnectorIdentity(peer) ? peer : latest.author;
  return { attribution: 'other', handle: identityHandle(author), text: preview };
}

export type DirectMessagePresence = {
  readonly label: string;
};

/** One counterparty-presence grammar for every DM surface. */
export function directMessagePresence(
  item: Pick<ChatListItem, 'directMessage' | 'agentState'>,
  nowMs: number,
): DirectMessagePresence | null {
  const direct = item.directMessage;
  if (!direct) return null;
  const presence = direct.presence;
  // An agent's presence ages out 90 seconds after its helper's last HTTP
  // call, so an idle agent waiting on its socket reads as offline. Only a
  // live turn is shown.
  if (direct.peer.kind === 'agent') {
    return item.agentState === 'working' ? { label: 'working' } : null;
  }
  if (presence?.status === 'online') return { label: 'online' };
  if (!presence?.observedAt) return null;
  return { label: personLastSeen(presence.observedAt, nowMs) };
}

/** Today is relative, yesterday is spoken, and older activity gets a calendar stamp. */
export function personLastSeen(observedAt: number, nowMs: number): string {
  const then = new Date(observedAt * 1_000);
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  if (startOfThen === startOfToday) {
    const elapsedHours = Math.max(0, Math.floor((nowMs - then.getTime()) / 3_600_000));
    if (elapsedHours > 0) return `last seen ${elapsedHours}h`;
    const elapsedMinutes = Math.max(1, Math.floor((nowMs - then.getTime()) / 60_000));
    return `last seen ${elapsedMinutes}m`;
  }
  if (startOfToday - startOfThen === 86_400_000) return 'yesterday';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(then);
}

function attachmentPreview(
  attachments: readonly { readonly mimeType: string }[] | undefined,
): string | undefined {
  const attachment = attachments?.[0];
  if (!attachment) return undefined;
  return attachment.mimeType.toLowerCase().startsWith('image/') ? 'Image' : 'Attachment';
}

/**
 * Whether the row's trailing brass square is lit. One square, one meaning:
 * this Room wants the viewer — a message newer than their read mark, or a
 * corner waiting on a human (`agentState === 'needs-you'`). A mention of the
 * viewer is attention only as part of unread: `mentionsViewer` is a fact about
 * the latest message's words and never clears on read. A working agent
 * is not attention; the square stays dark while it works. Unread is never
 * hidden behind agent state: an unread Room lights the square whatever its
 * agents are doing.
 */
export function roomRowNeedsAttention(
  item: Pick<ChatListItem, 'unread' | 'agentState' | 'latestMessage'>,
): boolean {
  return item.unread || item.agentState === 'needs-you';
}

/** The one gold replacement line for a Room that asks the viewer to act. */
export function roomRowAttentionReason(
  item: Pick<ChatListItem, 'unread' | 'agentState' | 'attentionReason' | 'latestMessage'>,
): string | null {
  if (item.agentState === 'needs-you') {
    const actor = item.attentionReason?.actor?.trim();
    return actor ? `approval \u00b7 ${actor}` : 'approval';
  }
  // Only while unread: the mention fact stays true after the viewer reads it.
  if (item.unread && item.latestMessage?.mentionsViewer) {
    return `mention \u00b7 @${identityHandle(item.latestMessage.author)}`;
  }
  return null;
}
