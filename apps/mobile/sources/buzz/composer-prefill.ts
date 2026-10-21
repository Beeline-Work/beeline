/**
 * The agent handle the composer offers before the person types.
 *
 * A quote-reply to an agent, or an agent's answer to the viewer as the newest
 * message, starts the composer with `@handle `. The tag is visible text: the
 * person sees who the message wakes and can delete it. Server routing is not
 * involved; only the typed tag addresses the agent.
 *
 * A prefill stays "untouched" while the composer text equals exactly what was
 * written. Only an untouched prefill may be replaced or cleared; any other
 * text belongs to the person and is never overwritten.
 */
import { resolveComposerMentions } from './room-participants';
import type { ChatDisplayMessage } from './room-view-presentation';

export type ComposerPrefill = {
  readonly kind: 'reply' | 'answer';
  readonly text: string;
  readonly handle: string;
  readonly sourceMessageId: string;
};

export type AnswerPrefillCandidate = {
  readonly handle: string;
  readonly pubkey: string;
  readonly sourceMessageId: string;
};

export type ComposerPrefillPlan =
  | { readonly kind: 'keep' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'fill'; readonly text: string; readonly prefill: ComposerPrefill | null };

export function prefillText(handle: string): string {
  return `@${handle.replace(/^@/, '')} `;
}

export function isUntouchedPrefill(draft: string, prefill: ComposerPrefill | null): boolean {
  return prefill !== null && draft === prefill.text;
}

/** Whether the text still carries a live tag for this exact agent. */
export function textTagsAgent(text: string, handle: string, pubkey: string): boolean {
  return resolveComposerMentions(
    text,
    [],
    new Map([[handle.replace(/^@/, ''), pubkey]]),
  ).pubkeys.includes(pubkey);
}

/**
 * The newest message in the Room, when it is an agent's answer to the viewer:
 * it tags the viewer, or its reply/request references a viewer message. Live turn
 * rows are transient and never count as the newest message. Before the viewer's
 * first message, a sole agent member is also offered, even before its hello.
 * Its stable Room-scoped key lets the same once-only/draft guards apply.
 */
export function answerPrefillCandidate(
  messages: readonly ChatDisplayMessage[],
  viewerPubkey: string,
  handleFor: (message: ChatDisplayMessage) => string | undefined,
  firstMessage?: {
    readonly roomId: string;
    readonly agents: readonly { readonly pubkey: string; readonly handle?: string }[];
    readonly viewerIsAgent: boolean;
  },
): AnswerPrefillCandidate | undefined {
  if (!viewerPubkey || firstMessage?.viewerIsAgent) return undefined;
  const soleAgent = firstMessage?.agents.length === 1 ? firstMessage.agents[0] : undefined;
  const firstHandle = soleAgent?.handle?.replace(/^@/, '');
  const initial =
    firstMessage && soleAgent && firstHandle &&
    !messages.some((message) => message.pubkey === viewerPubkey)
      ? {
          handle: firstHandle,
          pubkey: soleAgent.pubkey,
          sourceMessageId: `first-message:${firstMessage.roomId}:${soleAgent.pubkey}`,
        }
      : undefined;
  let newest: ChatDisplayMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.isAgentActivity || message.isAgentDraft || message.isAgentLiveTurn) continue;
    newest = message;
    break;
  }
  if (!newest?.isAgentAuthor || !newest.pubkey || newest.deleted) return initial;
  const handle = handleFor(newest)?.replace(/^@/, '');
  if (!handle) return initial;
  const replyToId = newest.replyToId;
  const requestId = newest.requestId;
  const answersViewer =
    Boolean(newest.mentionPubkeys?.includes(viewerPubkey)) ||
    Boolean(
      (replyToId || requestId) &&
      messages.some(
        (message) =>
          ((replyToId && (message.id === replyToId || message.relayId === replyToId)) ||
            (requestId && (message.id === requestId || message.relayId === requestId))) &&
          message.pubkey === viewerPubkey,
      ),
    );
  if (!answersViewer) return initial;
  return { handle, pubkey: newest.pubkey, sourceMessageId: newest.relayId ?? newest.id };
}

/**
 * Recompute the answer prefill when the newest message changes. Each agent
 * message is offered once: a prefill the person deleted is not written again.
 * A reply prefill belongs to its reply and is left alone.
 */
export function planAnswerPrefill(input: {
  readonly draft: string;
  readonly prefill: ComposerPrefill | null;
  readonly candidate: AnswerPrefillCandidate | undefined;
  readonly offered: ReadonlySet<string>;
}): ComposerPrefillPlan {
  const { draft, prefill, candidate } = input;
  const untouched = isUntouchedPrefill(draft, prefill);
  if (untouched && prefill?.kind === 'reply') return { kind: 'keep' };
  if (draft && !untouched) return { kind: 'keep' };
  if (untouched && candidate?.sourceMessageId === prefill?.sourceMessageId) return { kind: 'keep' };
  if (!candidate || input.offered.has(candidate.sourceMessageId))
    return untouched ? { kind: 'clear' } : { kind: 'keep' };
  const text = prefillText(candidate.handle);
  return {
    kind: 'fill',
    text,
    prefill: {
      kind: 'answer',
      text,
      handle: candidate.handle,
      sourceMessageId: candidate.sourceMessageId,
    },
  };
}

/**
 * Start a quote-reply to an agent with its handle. An empty composer or an
 * untouched prefill becomes `@handle `; a started draft keeps every word and
 * gains the handle in front, unless it already tags that agent.
 */
export function planReplyPrefill(input: {
  readonly draft: string;
  readonly prefill: ComposerPrefill | null;
  readonly handle: string;
  readonly pubkey: string;
  readonly sourceMessageId: string;
}): ComposerPrefillPlan {
  const handle = input.handle.replace(/^@/, '');
  const text = prefillText(handle);
  if (!input.draft.trim() || isUntouchedPrefill(input.draft, input.prefill)) {
    return {
      kind: 'fill',
      text,
      prefill: { kind: 'reply', text, handle, sourceMessageId: input.sourceMessageId },
    };
  }
  if (textTagsAgent(input.draft, handle, input.pubkey)) return { kind: 'keep' };
  return { kind: 'fill', text: `${text}${input.draft}`, prefill: null };
}
