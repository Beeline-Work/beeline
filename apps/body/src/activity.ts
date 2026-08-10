/**
 * Activity projection: subscribe to the edit session's ACP `session/update`
 * stream and project tool_call/message chunks as channel events every member
 * can see (kind:9 + #t=agent-activity tag).
 *
 * This is what makes "watch the agent work, together" real — the body bridges
 * the stdio-local ACP stream into the relay channel so all members receive live
 * agent activity.
 */
import type { AcpClient, SessionUpdate } from './acp.js';
import type { Identity } from '@beeline/gate';
import { publishEvent } from '@beeline/gate';
import { signEvent, type NostrEvent } from '@beeline/nostr';

export const ACTIVITY_TAG = 'agent-activity';

/** Batched activity to emit as a single channel event. */
export interface ActivityBatch {
  sessionId: string;
  channelId: string;
  events: SessionUpdate[];
}

/**
 * Project ACP session/update notifications into channel events.
 * Returns an unsubscribe function.
 */
export function projectActivity(
  client: AcpClient,
  channelId: string,
  channelOwner: Identity,
  sessionId: string,
): () => void {
  // Simple batching: emit on each update for low latency.
  // A production body should debounce at ~200ms for bursty tool calls.
  const onUpdate = (u: SessionUpdate) => {
    if (u.sessionId !== sessionId) return;
    void emitActivityEvent(channelId, channelOwner, u);
  };

  client.on('session/update', onUpdate);
  return () => {
    client.off('session/update', onUpdate);
  };
}

/** Emit a single session/update as a kind:9 channel event. */
async function emitActivityEvent(
  channelId: string,
  owner: Identity,
  update: SessionUpdate,
): Promise<void> {
  try {
    const content = JSON.stringify({
      sessionId: update.sessionId,
      update: update.update,
      projected: true,
    });

    const event: NostrEvent = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        tags: [
          ['h', channelId],
          ['t', ACTIVITY_TAG],
          ['session', update.sessionId],
        ],
        content,
      },
      owner.secretKey,
    );

    await publishEvent(event);
  } catch (err) {
    // Log but don't crash the body — activity projection is best-effort.
    console.error('[body] activity projection error:', err);
  }
}

/**
 * Post a control message to a channel (kind:9 with specific tag).
 * Used for: "subchannel opened", "session started", "session archived", etc.
 */
export async function postControlMessage(
  channelId: string,
  owner: Identity,
  msg: string,
  extraTags: string[][] = [],
): Promise<void> {
  const event: NostrEvent = signEvent(
    {
      pubkey: owner.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 9,
      tags: [
        ['h', channelId],
        ['t', 'body-control'],
        ...extraTags,
      ],
      content: msg,
    },
    owner.secretKey,
  );

  await publishEvent(event);
}