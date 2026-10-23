import type { KnownMessageReference } from '@beeline/buzz-client';
import { textTagsAgent } from './composer-prefill';
import type { ChatDisplayMessage } from './room-view-presentation';

export type MessageReplyDisplayTarget = {
  messageId: string;
  authorName: string;
  authorHandle?: string;
  authorPubkey?: string;
  isAgent: boolean;
  preview: string;
};

/** A message reply carries proof; live activity may borrow its turn's message. */
export type MessageReplyTarget = MessageReplyDisplayTarget & {
  reference?: KnownMessageReference;
};

export type PreparedMessageReply = {
  text: string;
  reference?: KnownMessageReference;
  /** A reply to an agent is an address even before the roster has hydrated. */
  agentPubkey?: string;
};

/**
 * Preserve the snapshot's parent proof. The composer already shows the agent's
 * handle as typed text; the reply addresses the agent only while that tag is
 * still there, so a person who deletes it sends an untagged reply.
 */
export function prepareMessageReply(
  text: string,
  target: MessageReplyTarget,
): PreparedMessageReply {
  const body = text.trim();
  const addressesAgent = Boolean(
    target.isAgent &&
      target.authorHandle &&
      target.authorPubkey &&
      textTagsAgent(body, target.authorHandle, target.authorPubkey),
  );
  return {
    text: body,
    ...(target.reference ? { reference: target.reference } : {}),
    ...(addressesAgent ? { agentPubkey: target.authorPubkey } : {}),
  };
}

export function agentActivityReplyExcerpt(message: ChatDisplayMessage): string {
  const ownText = message.text.trim();
  if (ownText) return ownText;
  const items = message.activity ?? [];
  const output = [...items]
    .reverse()
    .find((item) => item.kind === 'output' && Boolean(item.text?.trim()));
  if (output?.text?.trim()) return output.text.trim();
  const tool = [...items].reverse().find((item) => item.kind === 'tool');
  if (tool) return [tool.title, tool.command ?? tool.input].filter(Boolean).join(' · ');
  return items.at(-1)?.title?.trim() || 'Agent activity';
}

/** Activity borrows a real parent without pretending that the activity row is one. */
export function activityReplyParent(
  activity: ChatDisplayMessage,
  messages: readonly ChatDisplayMessage[],
): ChatDisplayMessage | undefined {
  const candidates = messages.filter(
    (message) =>
      !message.isAgentActivity &&
      message.isAgentAuthor &&
      message.pubkey === activity.pubkey &&
      message.reference,
  );
  return (
    [...candidates]
      .reverse()
      .find((message) => Boolean(activity.requestId && message.requestId === activity.requestId)) ??
    candidates.at(-1)
  );
}

/** Reply affordances and target installation share the same parent eligibility. */
export function canBeginReply(message: ChatDisplayMessage, roomId: string): boolean {
  return !message.isAgentDraft && Boolean(
    message.isAgentActivity || message.agentCommand || message.reference?.channelId === roomId,
  );
}

/**
 * The reply target for a transcript row, or null when the row cannot be a
 * parent in this Room. Activity rows borrow their turn's real parent. An
 * agent-command record has no server reference because it is emitted as a
 * card: Reply addresses the record's sender as an ordinary message instead of
 * inventing parent proof. A card that ever gains a real reference uses it.
 */
export function beginReplyTarget(
  message: ChatDisplayMessage,
  messages: readonly ChatDisplayMessage[],
  display: MessageReplyDisplayTarget,
  roomId: string,
): MessageReplyTarget | null {
  if (!canBeginReply(message, roomId)) return null;
  if (message.isAgentActivity) return activityMessageReplyTarget(message, messages, display);
  const target: MessageReplyTarget = {
    ...display,
    ...(message.reference ? { reference: message.reference } : {}),
  };
  if (message.agentCommand) return target;
  return target.reference?.channelId === roomId ? target : null;
}

export function activityMessageReplyTarget(
  activity: ChatDisplayMessage,
  messages: readonly ChatDisplayMessage[],
  display: MessageReplyDisplayTarget,
): MessageReplyTarget {
  const excerpt = agentActivityReplyExcerpt(activity);
  const parent = activityReplyParent(activity, messages);
  return {
    ...display,
    preview: parent?.text.trim() || excerpt,
    ...(parent?.reference ? { reference: parent.reference } : {}),
  };
}
