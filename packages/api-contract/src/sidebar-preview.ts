import type { ChatListItem, RoomLiveDelta, RoomViewMessage } from './phone-types.js';
import { readIdentity } from './phone-guards.js';

/** A list projection. It is never a complete Room message or transcript row. */
export type SidebarPreview = {
  readonly type: 'sidebar-preview';
  readonly roomId: string;
  readonly preview: Pick<RoomViewMessage, 'id' | 'text' | 'createdAt' | 'author' | 'presentation' | 'deleted'> & {
    readonly mentionsViewer?: true;
  };
  readonly deckPreview?: ChatListItem['latestMessage'] | null;
};
const TEXT_LIMIT = 240;
const ID_LIMIT = 128;

function authorPreview(author: RoomViewMessage['author']): RoomViewMessage['author'] {
  return { pubkey: author.pubkey, kind: author.kind, name: author.name.slice(0, 120),
    ...(author.handle ? { handle: author.handle.slice(0, 120) } : {}),
    ...(author.face && author.face.length <= 512 ? { face: author.face } : {}),
    ...(author.avatar && author.avatar.length <= 512 ? { avatar: author.avatar } : {}) };
}
function latestPreview(message: NonNullable<ChatListItem['latestMessage']>): NonNullable<ChatListItem['latestMessage']> {
  return { id: message.id, text: (message.text || (message.attachments?.length ? 'Attachment' : '')).slice(0, TEXT_LIMIT),
    createdAt: message.createdAt, author: authorPreview(message.author),
    ...(message.mentionsViewer ? { mentionsViewer: true } : {}) };
}

export function projectSidebarPreview(delta: Extract<RoomLiveDelta, { type: 'message-delta' }>, viewerId: string): SidebarPreview {
  const message = delta.message;
  return { type: 'sidebar-preview', roomId: delta.roomId,
    preview: { ...latestPreview({ ...message,
      ...(message.mentionPubkeys?.includes(viewerId) ? { mentionsViewer: true } : {}) }),
      presentation: message.presentation, ...(message.deleted ? { deleted: true } : {}) },
    ...('deckPreview' in delta ? { deckPreview: delta.deckPreview ? latestPreview(delta.deckPreview) : null } : {}) };
}

/** Reject oversized or malformed wire projections before list state sees them. */
export function readSidebarPreview(value: unknown): SidebarPreview | null {
  if (!value || typeof value !== 'object' || JSON.stringify(value).length > 8192) return null;
  const item = value as SidebarPreview;
  if (item.type !== 'sidebar-preview' || typeof item.roomId !== 'string' || item.roomId.length > ID_LIMIT) return null;
  const validLatest = (row: unknown): boolean => {
    if (!row || typeof row !== 'object') return false;
    const message = row as NonNullable<ChatListItem['latestMessage']>;
    return typeof message.id === 'string' && message.id.length <= ID_LIMIT &&
      typeof message.text === 'string' && message.text.length <= TEXT_LIMIT &&
      Number.isFinite(message.createdAt) && !!readIdentity(message.author) &&
      (message.mentionsViewer === undefined || message.mentionsViewer === true);
  };
  if (!validLatest(item.preview) || !['message', 'system', 'activity', 'card'].includes(item.preview.presentation) ||
      (item.preview.deleted !== undefined && typeof item.preview.deleted !== 'boolean') ||
      (item.deckPreview !== undefined && item.deckPreview !== null && !validLatest(item.deckPreview))) return null;
  return item;
}

/** At 1.6 Mbps, 2 KiB adds at most about 10 ms of serialization per frame.
 * NET-HOL-1's 128 KiB stress payload must remain a bounded preview.
 */
export function offscreenMessageFits(delta: Extract<RoomLiveDelta, { type: 'message-delta' }>): boolean {
  return new TextEncoder().encode(JSON.stringify(delta)).byteLength <= 2048;
}
