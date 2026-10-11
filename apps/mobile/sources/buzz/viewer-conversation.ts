import type { AttachmentReference } from '@beeline/buzz-client';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import type { DictatedSend } from '@/components/buzz/ConversationComposer';
import type { PickedChatAttachment } from '@/buzz/chat-attachment';

/** The open Room owns delivery and its live transcript even while a fill modal is on top. */
export type ViewerConversation = {
  roomId: string;
  messages: readonly RoomViewMessage[];
  send(input: ViewerMessage, dictated?: DictatedSend): Promise<boolean>;
};

export type ViewerMessage = {
  text: string;
  context: string;
  agentHandle?: string;
  artifact?: AttachmentReference;
  screenshotBase64?: string;
  pickedAttachments?: readonly PickedChatAttachment[];
};

const VIEWER_CONTEXT_PATTERN = /\n\n\[Viewing (artifact|browser): ([^\]\n]{1,120})\]$/;

export function viewerContext(kind: 'artifact' | 'computer', title: string): string {
  const safeTitle = title.replace(/[\r\n\[\]]/g, ' ').trim().slice(0, 120) || 'Untitled';
  return `Viewing ${kind === 'computer' ? 'browser' : 'artifact'}: ${safeTitle}`;
}

export function splitViewerContext(text: string): { body: string; context?: string } {
  const match = VIEWER_CONTEXT_PATTERN.exec(text);
  return match ? { body: text.slice(0, match.index), context: `Viewing ${match[1]}: ${match[2]}` }
    : { body: text };
}

export function viewerAgentHandle(
  kind: 'artifact' | 'computer',
  preferred: string | undefined,
  messages: readonly RoomViewMessage[],
): string | undefined {
  const agents = messages.filter((message) => message.author.kind === 'agent');
  const preferredHandle = preferred?.replace(/^@/, '');
  if (preferredHandle && (kind === 'computer' || agents.some((message) =>
    message.author.handle?.replace(/^@/, '') === preferredHandle))) return preferredHandle;
  return [...agents].reverse()[0]?.author.handle?.replace(/^@/, '');
}

const sessions = new Map<string, ViewerConversation>();
const listeners = new Set<() => void>();

export function publishViewerConversation(conversation: ViewerConversation): void {
  sessions.set(conversation.roomId, conversation);
  for (const listener of listeners) listener();
}

export function removeViewerConversation(roomId: string): void {
  if (sessions.delete(roomId)) for (const listener of listeners) listener();
}

export function currentViewerConversation(roomId?: string): ViewerConversation | undefined {
  if (roomId) return sessions.get(roomId);
  return [...sessions.values()].at(-1);
}

export function subscribeViewerConversation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
