import type { KnownMessageReference } from '@beeline/buzz-client';
import type { ChatDisplayMessage } from './room-view-presentation';

export type MessageReplyDisplayTarget = {
  messageId: string;
  authorName: string;
  authorHandle?: string;
  authorPubkey?: string;
  isAgent: boolean;
  preview: string;
};

/** A message reply carries proof; live activity may instead become a quoted steer. */
export type MessageReplyTarget = MessageReplyDisplayTarget & {
  reference?: KnownMessageReference;
  /** Activity is not a message, so keep the exact prose/tool excerpt in-band. */
  quotedExcerpt?: string;
};

export type PreparedMessageReply = {
  text: string;
  reference?: KnownMessageReference;
  /** A reply to an agent is an address even before the roster has hydrated. */
  agentPubkey?: string;
};

export function replyMessageText(text: string, agentHandle?: string): string {
  const body = text.trim();
  return agentHandle ? `@${agentHandle} ${body}` : body;
}

/** Preserve the snapshot's parent proof and the parent agent's exact identity together. */
export function prepareMessageReply(
  text: string,
  target: MessageReplyTarget,
): PreparedMessageReply {
  const addressed = replyMessageText(text, target.isAgent ? target.authorHandle : undefined);
  const quoted = target.quotedExcerpt
    ?.trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return {
    text: quoted ? `${quoted}\n\n${addressed}` : addressed,
    ...(target.reference ? { reference: target.reference } : {}),
    ...(target.isAgent && target.authorPubkey ? { agentPubkey: target.authorPubkey } : {}),
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

export function activityMessageReplyTarget(
  activity: ChatDisplayMessage,
  messages: readonly ChatDisplayMessage[],
  display: MessageReplyDisplayTarget,
): MessageReplyTarget {
  const excerpt = agentActivityReplyExcerpt(activity);
  const parent = activityReplyParent(activity, messages);
  return {
    ...display,
    preview: excerpt,
    quotedExcerpt: excerpt,
    ...(parent?.reference ? { reference: parent.reference } : {}),
  };
}
