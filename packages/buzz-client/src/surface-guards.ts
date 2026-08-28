import type {
  AgentDetailView,
  ChatListView,
  CornerListView,
  InviteView,
  RoomHistoryView,
  RoomView,
  RoomViewIdentity,
  RoomViewMessage,
  WorkspaceListView,
  WorkspaceView,
} from './room-view.js';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function identity(value: unknown): value is RoomViewIdentity {
  const item = record(value);
  return Boolean(item && typeof item.pubkey === 'string' && /^[0-9a-f]{64}$/.test(item.pubkey) &&
    (item.kind === 'human' || item.kind === 'agent') && typeof item.name === 'string');
}

function message(value: unknown): value is RoomViewMessage {
  const item = record(value);
  const reference = record(item?.reference);
  return Boolean(item && typeof item.id === 'string' && /^[0-9a-f]{64}$/.test(item.id) &&
    typeof item.text === 'string' && Number.isSafeInteger(item.createdAt) && identity(item.author) &&
    (item.presentation === 'message' || item.presentation === 'system' ||
      item.presentation === 'activity' || item.presentation === 'card') &&
    (!reference || (reference.channelId && reference.eventId === item.id && reference.rootId)));
}

function watchFilters(value: unknown): boolean {
  return Array.isArray(value) && value.every((candidate) => Boolean(record(candidate)));
}

export function isRoomView(value: unknown): value is RoomView {
  const item = record(value);
  const room = record(item?.room);
  const viewer = record(item?.viewer);
  return Boolean(item && room && typeof room.id === 'string' && typeof room.workspaceId === 'string' &&
    Array.isArray(item.messages) && item.messages.every(message) &&
    Array.isArray(item.members) && item.members.every((member) => identity(record(member)?.identity)) &&
    viewer && identity(viewer.identity) && watchFilters(item.watchFilters));
}

export function isRoomHistoryView(value: unknown): value is RoomHistoryView {
  const item = record(value);
  return Boolean(item && typeof item.roomId === 'string' && Array.isArray(item.messages) &&
    item.messages.every(message));
}

export function isWorkspaceListView(value: unknown): value is WorkspaceListView {
  const item = record(value);
  return Boolean(item && Array.isArray(item.workspaces) && typeof item.truncated === 'boolean' &&
    identity(item.viewer) && watchFilters(item.watchFilters));
}

export function isWorkspaceView(value: unknown): value is WorkspaceView {
  const item = record(value);
  return Boolean(item && record(item.workspace) && Array.isArray(item.members) &&
    Array.isArray(item.agents) && typeof item.membersTruncated === 'boolean' &&
    typeof item.agentsTruncated === 'boolean' && watchFilters(item.watchFilters));
}

export function isChatListView(value: unknown): value is ChatListView {
  const item = record(value);
  return Boolean(item && record(item.workspace) && Array.isArray(item.chats) &&
    typeof item.truncated === 'boolean' && identity(item.viewer) && watchFilters(item.watchFilters));
}

export function isCornerListView(value: unknown): value is CornerListView {
  const item = record(value);
  return Boolean(item && record(item.room) && Array.isArray(item.corners) &&
    watchFilters(item.watchFilters));
}

export function isAgentDetailView(value: unknown): value is AgentDetailView {
  const item = record(value);
  return Boolean(item && typeof item.workspaceId === 'string' && record(item.agent) &&
    identity(record(item.agent)?.identity) && Array.isArray(item.catalog) && watchFilters(item.watchFilters));
}

export function isInviteView(value: unknown): value is InviteView {
  const item = record(value);
  if (!item || typeof item.name !== 'string' || !Number.isSafeInteger(item.expiresAt)) return false;
  if (item.avatar !== undefined && typeof item.avatar !== 'string') return false;
  return Object.keys(item).every((key) => key === 'name' || key === 'avatar' || key === 'expiresAt');
}
