import { signEvent, type NostrEvent } from '@beeline/nostr';
import { KIND_STREAM_MESSAGE } from './kinds.js';
import type { Identity } from './types.js';
import type { KnownMessageReference } from './reply-proof.js';

export type ReplyCommandOptions = {
  mentionAgent?: string;
  mentionPubkeys?: readonly string[];
  /** Attachment/metadata tags only. Room and ancestry tags are builder-owned. */
  contentTags?: readonly (readonly string[])[];
};

function assertProof(parent: KnownMessageReference): void {
  if (!parent.channelId || !parent.eventId || !parent.rootId) {
    throw new Error('reply requires a complete same-Room message proof');
  }
}

/**
 * The only reply command constructor. Its opaque snapshot proof owns the Room,
 * root, and direct parent so callers cannot sign a contradictory NIP-10 shape.
 */
export function buildReplyCommand(
  identity: Identity,
  text: string,
  parent: KnownMessageReference,
  options: ReplyCommandOptions = {},
): NostrEvent {
  assertProof(parent);
  const contentTags = (options.contentTags ?? []).map((tag) => [...tag]);
  if (contentTags.some((tag) => tag[0] === 'h' || tag[0] === 'e')) {
    throw new Error('reply Room and ancestry tags are builder-owned');
  }
  const mentioned = new Set(options.mentionPubkeys ?? []);
  if (options.mentionAgent) mentioned.add(options.mentionAgent);
  const tags: string[][] = [
    ['h', parent.channelId],
    ...[...mentioned].map((pubkey) => ['p', pubkey]),
    ...(parent.rootId === parent.eventId ? [] : [['e', parent.rootId, '', 'root']]),
    ['e', parent.eventId, '', 'reply'],
    ...contentTags,
  ];
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: KIND_STREAM_MESSAGE,
      tags,
      content: text,
    },
    identity.secretKey,
  );
}
