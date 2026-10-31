import { RoomViewHttpError, type RoomViewClientOptions } from '@beeline/buzz-client';
import {
  readAgentVoiceCatalog,
  readAgentVoicePreview,
  readAgentDetailView,
  readAgentPairingClaimView,
  readChatListView,
  readCornerListView,
  readInviteView,
  readMessageSearchView,
  readMessageLinkView,
  readRoomHistoryOutline,
  readRoomHistoryView,
  readRoomView,
  readWorkspaceListView,
  readWorkspaceMemberListView,
  readWorkspaceView,
  type SurfaceReader,
  type AgentDetailView,
  type AgentPairingClaimView,
  type ChatListView,
  type CornerListView,
  type InviteView,
  type MessageSearchView,
  type RoomHistoryOutline,
  type RoomHistoryView,
  type RoomView,
  type RoomViewMessage,
  type WorkspaceListView,
  type WorkspaceMemberListQuery,
  type WorkspaceMemberListView,
  type WorkspaceView,
} from '@beeline/api-contract/phone';
import { MonolithRequestTimeoutError, MONOLITH_REQUEST_TIMEOUT_MS } from '@/auth/monolith-session';
import { markRoomOpen } from '@/buzz/room-open-trace';
import { sharedLiveConnection } from './live-connection';
import { PhoneSocketError } from './phone-socket-error';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { liveFrameEpoch } from './live-frame-epoch';
import { stampRoomMessageRows } from '@/buzz/room-message-records';
import { currentSurfaceStamp } from '@/buzz/surface-clock';

export { RoomViewHttpError };

/**
 * Identical GETs in flight at once share one request: every screen mounting
 * on the same open asks for the same Workspace, Room list or Room. A caller
 * that asks after the live socket delivered anything new starts its own read,
 * because the shared one may predate the change that frame announced.
 */
const readsInFlight = new Map<string, { promise: Promise<unknown>; epoch: number }>();

function shareRead<T>(key: string, start: () => Promise<T>): Promise<T> {
  const epoch = liveFrameEpoch();
  const shared = readsInFlight.get(key);
  if (shared && shared.epoch === epoch) {
    if (key.startsWith('["readRoom",')) markRoomOpen('wire-shared');
    return shared.promise as Promise<T>;
  }
  const promise = start();
  const entry = { promise, epoch };
  readsInFlight.set(key, entry);
  const release = () => {
    if (readsInFlight.get(key) === entry) readsInFlight.delete(key);
  };
  promise.then(release, release);
  return promise;
}

/** A bounded deadline fired before the server answered the phone's read. */
export function isRoomViewTimeoutError(error: unknown): boolean {
  if (error instanceof MonolithRequestTimeoutError) return true;
  if (error instanceof RoomViewHttpError) {
    return error.code === 'timeout' || error.code === 'surface_request_timed_out';
  }
  return false;
}

type Guard<T> = SurfaceReader<T>;

class MonolithRoomViewClient {
  resolveMessageLink(messageId: string) {
    return this.get('resolveMessageLink', { messageId }, readMessageLinkView);
  }
  workspaces(): Promise<WorkspaceListView> { return this.get('readWorkspaces', {}, readWorkspaceListView); }
  workspace(workspaceId: string): Promise<WorkspaceView> {
    return this.get('readWorkspace', { workspaceId }, readWorkspaceView);
  }
  workspaceMembers(workspaceId: string, query: WorkspaceMemberListQuery = {}): Promise<WorkspaceMemberListView> {
    return this.get('readWorkspaceMembers', { workspaceId, ...query }, readWorkspaceMemberListView);
  }
  agent(workspaceId: string, agentId: string, workCursor?: string): Promise<AgentDetailView> {
    return this.get('readAgent', { workspaceId, agentId, workCursor }, readAgentDetailView);
  }
  agentVoices(workspaceId: string, agentId: string, roomId?: string) {
    return this.get('readAgentVoices', { workspaceId, agentId, roomId }, readAgentVoiceCatalog);
  }
  setAgentVoice(workspaceId: string, agentId: string, voiceId: string) {
    return this.checked('saveAgentVoice', { workspaceId, agentId, voiceId }, readAgentVoiceCatalog);
  }
  previewAgentVoice(workspaceId: string, agentId: string, voiceId: string) {
    return this.checked('previewAgentVoice', { workspaceId, agentId, voiceId }, readAgentVoicePreview);
  }
  chats(workspaceId: string): Promise<ChatListView> {
    return this.get('readChats', { workspaceId }, readChatListView);
  }
  room(roomId: string): Promise<RoomView> { return this.get('readRoom', { roomId }, readRoomView); }
  corners(roomId: string, options: { readonly archived?: boolean; readonly before?: string; readonly openBefore?: string } = {}): Promise<CornerListView> {
    return this.get('readCorners', { roomId, ...options }, readCornerListView);
  }
  history(roomId: string, before?: { createdAt: number; id: string }): Promise<RoomHistoryView> {
    return this.get('readHistory', { roomId, before }, readRoomHistoryView);
  }
  historyAfter(roomId: string, messageId: string): Promise<RoomHistoryView> {
    return this.get('readHistoryAfter', { roomId, messageId }, readRoomHistoryView);
  }
  historyAround(roomId: string, messageId: string): Promise<RoomHistoryView> {
    return this.get('readHistoryAround', { roomId, messageId }, readRoomHistoryView);
  }
  outline(roomId: string, timeZone: string): Promise<RoomHistoryOutline> {
    return this.get('readHistoryOutline', { roomId, timeZone }, readRoomHistoryOutline);
  }
  searchMessages(workspaceId: string, query: string, before?: string, signal?: AbortSignal): Promise<MessageSearchView> {
    return this.get('searchMessages', { workspaceId, query, before }, readMessageSearchView, signal);
  }
  invite(token: string): Promise<InviteView> { return this.checked('resolveInvite', { token }, readInviteView); }
  claimAgentPairing(code: string): Promise<AgentPairingClaimView> {
    return this.checked('claimAgentPairing', { code }, readAgentPairingClaimView);
  }
  abandonAgentPairing(): Promise<never> {
    return Promise.reject(new Error('Pairing abandon is not available on the phone API'));
  }
  markRead(roomId: string, messageId: string): Promise<void> { return this.request('markRead', { roomId, messageId }).then(() => undefined); }
  markUnread(roomId: string, messageId: string): Promise<void> { return this.request('markUnread', { roomId, messageId }).then(() => undefined); }

  private get<Name extends keyof PhoneOperationMap, T>(name: Name, input: PhoneOperationMap[Name]['input'], guard: Guard<T>, signal?: AbortSignal): Promise<T> {
    if (signal) return this.checked(name, input, guard, signal);
    return shareRead(JSON.stringify([name, input]), () => this.checked(name, input, guard));
  }
  private async checked<Name extends keyof PhoneOperationMap, T>(name: Name, input: PhoneOperationMap[Name]['input'], guard: Guard<T>, signal?: AbortSignal): Promise<T> {
    const value = await this.request(name, input, signal);
    if (name === 'readRoom') markRoomOpen('wire-body');
    const projected = guard(value);
    if (projected === null) throw new RoomViewHttpError(502, 'invalid_surface_response');
    return projected;
  }
  private async request<Name extends keyof PhoneOperationMap>(name: Name, input: PhoneOperationMap[Name]['input'], signal?: AbortSignal): Promise<PhoneOperationMap[Name]['output']> {
    try {
      const result = await sharedLiveConnection().request(name, input, { signal, timeoutMs: MONOLITH_REQUEST_TIMEOUT_MS });
      if (name === 'readRoom') markRoomOpen('wire-headers');
      return result;
    } catch (error) {
      if (error instanceof MonolithRequestTimeoutError) throw new RoomViewHttpError(0, 'timeout');
      if (error instanceof PhoneSocketError) throw new RoomViewHttpError(error.status, error.code);
      throw error;
    }
  }
}

/** A push can begin this read before the Room identity/relay setup completes. */
export function readPushedMonolithRoom(roomId: string): Promise<RoomView> {
  return new MonolithRoomViewClient().room(roomId);
}

/** A Room or history response keeps its read-start clock for live identity and viewer state. */
function stamped<T>(read: Promise<T>, stamp = currentSurfaceStamp()): Promise<T> {
  return read.then((value) => {
    const { messages, toolRows } = value as {
      messages?: readonly RoomViewMessage[];
      toolRows?: readonly RoomViewMessage[];
    };
    stampRoomMessageRows([...(messages ?? []), ...(toolRows ?? [])], stamp);
    return value;
  });
}

/** Stable read seam over the monolith reader. */
export class RoomViewClient {
  private readonly implementation = new MonolithRoomViewClient();
  // Callers still describe their relay and identity; the monolith reader authenticates itself.
  constructor(_options: RoomViewClientOptions) {}
  resolveMessageLink(messageId: string) {
    return this.implementation.resolveMessageLink(messageId);
  }
  workspaces() {
    return this.implementation.workspaces();
  }
  workspace(id: string) {
    return this.implementation.workspace(id);
  }
  workspaceMembers(id: string, query?: WorkspaceMemberListQuery) {
    return this.implementation.workspaceMembers(id, query);
  }
  agent(workspaceId: string, agentId: string, workCursor?: string) {
    return this.implementation.agent(workspaceId, agentId, workCursor);
  }
  agentVoices(workspaceId: string, agentId: string, roomId?: string) {
    return this.implementation.agentVoices(workspaceId, agentId, roomId);
  }
  setAgentVoice(workspaceId: string, agentId: string, voiceId: string) {
    return this.implementation.setAgentVoice(workspaceId, agentId, voiceId);
  }
  previewAgentVoice(
    workspaceId: string,
    agentId: string,
    voiceId: string,
  ) {
    return this.implementation.previewAgentVoice(workspaceId, agentId, voiceId);
  }
  chats(id: string) {
    return this.implementation.chats(id);
  }
  room(id: string) {
    return stamped(this.implementation.room(id));
  }
  /** `before` is an archived page's `nextArchived` cursor. */
  corners(
    id: string,
    options?: {
      readonly archived?: boolean;
      readonly before?: string;
      readonly openBefore?: string;
    },
  ) {
    return this.implementation.corners(id, options);
  }
  history(id: string, before?: { createdAt: number; id: string }) {
    return stamped(this.implementation.history(id, before));
  }
  historyAfter(id: string, messageId: string): Promise<RoomHistoryView> {
    return stamped(this.implementation.historyAfter(id, messageId));
  }
  historyAround(id: string, messageId: string): Promise<RoomHistoryView> {
    return stamped(this.implementation.historyAround(id, messageId));
  }
  outline(id: string, timeZone: string): Promise<RoomHistoryOutline | null> {
    return this.implementation.outline(id, timeZone);
  }
  searchMessages(
    workspaceId: string,
    query: string,
    before?: string,
    signal?: AbortSignal,
  ): Promise<MessageSearchView | null> {
    return this.implementation.searchMessages(workspaceId, query, before, signal);
  }
  invite(token: string) {
    return this.implementation.invite(token);
  }
  claimAgentPairing(code: string) {
    return this.implementation.claimAgentPairing(code);
  }
  abandonAgentPairing(_code: string) {
    return this.implementation.abandonAgentPairing();
  }
  markRead(roomId: string, messageId: string): Promise<void> {
    return this.implementation.markRead(roomId, messageId);
  }
  markUnread(roomId: string, messageId: string): Promise<void> {
    return this.implementation.markUnread(roomId, messageId);
  }
}
